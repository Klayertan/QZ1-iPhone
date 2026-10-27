// A small NMEA 0183 parser and receiver-state tracker. No dependencies.
//
// Feed it lines with GnssState.push(line); read the result with snapshot().
// Handles GGA (fix), RMC (speed, course, date), GSA (satellites used, DOP) and
// GSV (satellites in view), from any talker (GP, GL, GA, GB, GQ, GN).

/** true / false for a sentence with a checksum, null when it has none. */
export function checksumOk(sentence) {
  const star = sentence.lastIndexOf("*");
  if (!sentence.startsWith("$") || star < 0) return null;
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= sentence.charCodeAt(i);
  const given = /^[0-9A-Fa-f]{2}/.test(sentence.slice(star + 1)) ? parseInt(sentence.slice(star + 1, star + 3), 16) : NaN;
  return Number.isFinite(given) && sum === given;
}

/** "3439.2705","N" -> 34.65450833; "13549.8410","E" -> 135.83068. Returns null if blank/invalid. */
export function parseCoordinate(value, hemisphere) {
  if (!value || !/^\d+\.?\d*$/.test(value)) return null;
  const number = Number(value);
  const degrees = Math.floor(number / 100);
  const decimal = degrees + (number - degrees * 100) / 60;
  return hemisphere === "S" || hemisphere === "W" ? -decimal : decimal;
}

export const FIX_LABELS = {
  0: "No fix",
  1: "GPS (single)",
  2: "DGPS / SBAS",
  3: "PPS",
  4: "RTK fixed",
  5: "RTK float",
  6: "Dead reckoning",
  7: "Manual",
  8: "Simulation"
};

/** Which satellite system a GSV entry belongs to. QZSS PRNs 193-202 are reported under the GPS talker. */
export function constellationFor(talker, prn) {
  if (talker === "GQ" || (talker === "GP" && prn >= 193 && prn <= 202) || (talker === "GN" && prn >= 193 && prn <= 202)) return "QZSS";
  if (talker === "GP") return "GPS";
  if (talker === "GL") return "GLONASS";
  if (talker === "GA") return "Galileo";
  if (talker === "GB" || talker === "BD") return "BeiDou";
  if (prn >= 1 && prn <= 32) return "GPS";
  if (prn >= 65 && prn <= 96) return "GLONASS";
  return "Other";
}

/** Splits "$GNGGA,...*5C" into { talker, type, fields, checksum }. Returns null if it is not a sentence. */
export function splitSentence(line) {
  const start = line.indexOf("$");
  if (start < 0) return null;
  const sentence = line.slice(start).trim();
  const checksum = checksumOk(sentence);
  const star = sentence.lastIndexOf("*");
  const fields = (star >= 0 ? sentence.slice(1, star) : sentence.slice(1)).split(",");
  const head = fields[0];
  if (head.length < 4) return null;
  if (head.startsWith("P")) return { talker: "", type: head, fields, checksum };
  return { talker: head.slice(0, 2), type: head.slice(2), fields, checksum };
}

function number(value) {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class GnssState {
  /**
   * @param now clock (ms), replaceable in tests
   * @param ttlMs how long a satellite list / used list stays valid without an update
   */
  constructor({ now = () => Date.now(), ttlMs = 15000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.reset();
  }

  reset() {
    this.fix = null;            // from GGA
    this.fixAt = 0;
    this.motion = null;         // from RMC
    this.dop = { pdop: null, hdop: null, vdop: null };
    this.gsvBuffer = new Map(); // talker -> { entries, total } while a GSV cycle is arriving
    this.gsv = new Map();       // talker -> { at, entries } last complete cycle
    this.used = new Map();      // talker+system -> { at, prns }
    this.counts = { lines: 0, sentences: 0, badChecksum: 0 };
  }

  /** @returns {string|null} the sentence type that was understood, or null */
  push(line) {
    this.counts.lines += 1;
    const s = splitSentence(line);
    if (!s) return null;
    this.counts.sentences += 1;
    if (s.checksum === false) {
      this.counts.badChecksum += 1;
      return null; // a damaged sentence is never used
    }
    switch (s.type) {
      case "GGA": this._gga(s.fields); break;
      case "RMC": this._rmc(s.fields); break;
      case "GSA": this._gsa(s); break;
      case "GSV": this._gsv(s); break;
      default: return null;
    }
    return s.type;
  }

  _gga(f) {
    const quality = number(f[6]) ?? 0;
    this.fix = {
      utc: f[1] || null,
      lat: parseCoordinate(f[2], f[3]),
      lon: parseCoordinate(f[4], f[5]),
      quality,
      qualityLabel: FIX_LABELS[quality] ?? `Quality ${quality}`,
      satellitesUsed: number(f[7]),
      hdop: number(f[8]),
      altitude: number(f[9])
    };
    if (this.fix.hdop !== null) this.dop.hdop = this.fix.hdop;
    this.fixAt = this.now();
  }

  _rmc(f) {
    const knots = number(f[7]);
    this.motion = {
      valid: f[2] === "A",
      speedKmh: knots === null ? null : knots * 1.852,
      courseDeg: number(f[8]),
      date: f[9] || null
    };
  }

  _gsa(s) {
    const f = s.fields;
    const prns = f.slice(3, 15).filter((p) => p !== "").map(Number).filter(Number.isFinite);
    this.used.set(`${s.talker}${f[18] ?? ""}`, { at: this.now(), prns: new Set(prns) });
    this.dop.pdop = number(f[15]) ?? this.dop.pdop;
    this.dop.hdop = number(f[16]) ?? this.dop.hdop;
    this.dop.vdop = number(f[17]) ?? this.dop.vdop;
  }

  _gsv(s) {
    const f = s.fields;
    const total = number(f[1]);
    const index = number(f[2]);
    if (total === null || index === null) return;
    if (index === 1 || !this.gsvBuffer.has(s.talker)) this.gsvBuffer.set(s.talker, { entries: [], total });
    const buffer = this.gsvBuffer.get(s.talker);
    // After the 4 header fields come groups of 4 (PRN, elevation, azimuth, SNR); a trailing signal-id field is ignored.
    const groups = Math.floor((f.length - 4) / 4);
    for (let g = 0; g < groups; g++) {
      const i = 4 + g * 4;
      const prn = number(f[i]);
      if (prn === null) continue;
      buffer.entries.push({
        prn,
        constellation: constellationFor(s.talker, prn),
        elevation: number(f[i + 1]),
        azimuth: number(f[i + 2]),
        snr: number(f[i + 3])
      });
    }
    if (index === total) {
      this.gsv.set(s.talker, { at: this.now(), entries: buffer.entries });
      this.gsvBuffer.delete(s.talker);
    }
  }

  snapshot() {
    const now = this.now();
    const usedPrns = new Set();
    for (const { at, prns } of this.used.values()) {
      if (now - at <= this.ttlMs) prns.forEach((prn) => usedPrns.add(prn));
    }
    const satellites = [];
    for (const { at, entries } of this.gsv.values()) {
      if (now - at > this.ttlMs) continue;
      for (const entry of entries) satellites.push({ ...entry, used: usedPrns.has(entry.prn) });
    }
    const order = ["QZSS", "GPS", "GLONASS", "Galileo", "BeiDou", "Other"];
    satellites.sort((a, b) => order.indexOf(a.constellation) - order.indexOf(b.constellation) || a.prn - b.prn);
    return {
      fix: this.fix,
      fixAgeMs: this.fixAt ? now - this.fixAt : null,
      motion: this.motion,
      dop: { ...this.dop },
      satellites,
      usedCount: usedPrns.size,
      counts: { ...this.counts }
    };
  }
}
