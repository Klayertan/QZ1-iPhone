import test from "node:test";
import assert from "node:assert/strict";
import { checksumOk, parseCoordinate, splitSentence, constellationFor, GnssState } from "../web/nmea.js";

function sentence(body) {
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, "0")}`;
}

const GGA = sentence("GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,");
const RMC = sentence("GNRMC,012345.00,A,3439.2705,N,13549.8410,E,1.00,90.0,120726,,,D");
const GSA = sentence("GNGSA,A,3,07,10,193,,,,,,,,,,1.2,0.9,0.8");
const GSV1 = sentence("GPGSV,2,1,06,07,45,120,38,08,30,200,27,10,60,010,41,13,15,300,");
const GSV2 = sentence("GPGSV,2,2,06,193,70,180,44,194,12,045,20");

test("checksum: right, wrong, and none", () => {
  assert.equal(checksumOk(GGA), true);
  assert.equal(checksumOk(GGA.replace("45.0", "46.0")), false);
  assert.equal(checksumOk("$GNGGA,1,2,3"), null);
  assert.equal(checksumOk("$GNGGA,1,2,3*ZZ"), false);
});

test("coordinates: ddmm.mmmm with hemisphere", () => {
  assert.ok(Math.abs(parseCoordinate("3439.2705", "N") - 34.654508333) < 1e-8);
  assert.ok(Math.abs(parseCoordinate("13549.8410", "E") - 135.830683333) < 1e-8);
  assert.ok(parseCoordinate("3439.2705", "S") < 0);
  assert.equal(parseCoordinate("", "N"), null);
});

test("splitSentence takes talker and type apart, and tolerates a prefix before the $", () => {
  const s = splitSentence(`12:00:01 ${GGA}`);
  assert.equal(s.talker, "GN");
  assert.equal(s.type, "GGA");
  assert.equal(s.checksum, true);
  assert.equal(splitSentence("hello"), null);
  assert.equal(splitSentence("$PQTMVER,1,2*00").type, "PQTMVER");
});

test("QZSS is recognised by talker or by PRN 193-202", () => {
  assert.equal(constellationFor("GQ", 1), "QZSS");
  assert.equal(constellationFor("GP", 193), "QZSS");
  assert.equal(constellationFor("GP", 7), "GPS");
  assert.equal(constellationFor("GL", 70), "GLONASS");
  assert.equal(constellationFor("GA", 5), "Galileo");
  assert.equal(constellationFor("GB", 12), "BeiDou");
});

test("a full epoch produces the fix, motion, DOP and satellites", () => {
  const state = new GnssState({ now: () => 1000 });
  for (const line of [GSV1, GSV2, GSA, GGA, RMC]) assert.ok(state.push(line));
  const snap = state.snapshot();
  assert.equal(snap.fix.quality, 2);
  assert.equal(snap.fix.qualityLabel, "DGPS / SBAS");
  assert.equal(snap.fix.satellitesUsed, 14);
  assert.equal(snap.fix.hdop, 0.9);
  assert.equal(snap.fix.altitude, 45);
  assert.ok(Math.abs(snap.fix.lat - 34.654508) < 1e-5);
  assert.equal(snap.motion.valid, true);
  assert.ok(Math.abs(snap.motion.speedKmh - 1.852) < 1e-9);
  assert.equal(snap.motion.courseDeg, 90);
  assert.deepEqual(snap.dop, { pdop: 1.2, hdop: 0.9, vdop: 0.8 });
  assert.equal(snap.satellites.length, 6);
  assert.equal(snap.satellites[0].constellation, "QZSS");       // QZSS first
  assert.equal(snap.satellites.find((s) => s.prn === 193).used, true);
  assert.equal(snap.satellites.find((s) => s.prn === 8).used, false);
  assert.equal(snap.usedCount, 3);
});

test("a sentence with a wrong checksum is counted and never used", () => {
  const state = new GnssState();
  assert.equal(state.push(GGA.replace("45.0", "99.0")), null);
  assert.equal(state.snapshot().fix, null);
  assert.equal(state.snapshot().counts.badChecksum, 1);
});

test("a satellite list that stops updating expires", () => {
  let now = 0;
  const state = new GnssState({ now: () => now, ttlMs: 5000 });
  state.push(GSV1);
  state.push(GSV2);
  assert.equal(state.snapshot().satellites.length, 6);
  now = 6000;
  assert.equal(state.snapshot().satellites.length, 0);
});

test("a GSV cycle is only used once complete, and a new cycle replaces the old", () => {
  const state = new GnssState({ now: () => 0 });
  state.push(GSV1);                       // message 1 of 2 only
  assert.equal(state.snapshot().satellites.length, 0);
  state.push(GSV2);
  assert.equal(state.snapshot().satellites.length, 6);
  state.push(sentence("GPGSV,1,1,01,09,10,020,30"));   // next cycle: a single sentence
  assert.deepEqual(state.snapshot().satellites.map((s) => s.prn), [9]);
});

test("no fix is reported as quality 0, and a missing HDOP stays null", () => {
  const state = new GnssState();
  state.push(sentence("GNGGA,012345.00,,,,,0,00,,,M,,M,,"));
  const fix = state.snapshot().fix;
  assert.equal(fix.quality, 0);
  assert.equal(fix.qualityLabel, "No fix");
  assert.equal(fix.lat, null);
  assert.equal(fix.hdop, null);
});

test("a trailing NMEA 4.10 signal-id field on GSV is ignored", () => {
  const state = new GnssState({ now: () => 0 });
  state.push(sentence("GAGSV,1,1,01,05,40,100,35,7"));
  assert.deepEqual(state.snapshot().satellites.map((s) => [s.prn, s.constellation, s.snr]), [[5, "Galileo", 35]]);
});
