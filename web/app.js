import { GnssState } from "./nmea.js";
import { BleTransport, WifiTransport } from "./transports.js";

const $ = (id) => document.getElementById(id);
const state = new GnssState();
let transport = null;
let recording = null;        // array of raw lines while recording, else null
let recorded = [];           // the last finished recording
let rawTail = [];
let linesInWindow = 0;
let linesPerSecond = 0;
let lastLineAt = 0;
let bridgeText = "";         // what the transport last said ("connecting…", "QZ1 not linked", ...)
let wakeLock = null;

const params = new URLSearchParams(location.search);
// Wi-Fi mode: the bridge serves this page over plain http, so its WebSocket is on the same host.
const wifiUrl = params.get("ws") || (location.protocol === "http:" ? `ws://${location.hostname}:81/` : null);
const bleOk = BleTransport.supported();

function onLine(line) {
  lastLineAt = Date.now();
  linesInWindow += 1;
  state.push(line);
  rawTail.push(line);
  if (rawTail.length > 40) rawTail.shift();
  if (recording) recording.push(line);
}

function setConnected(on) {
  $("connectBle").hidden = on || !bleOk;
  $("connectWifi").hidden = on || !wifiUrl;
  $("disconnect").hidden = !on;
  $("state").classList.toggle("on", on);
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");   // https pages only; the Wi-Fi page is plain http
  } catch {
    wakeLock = null;
  }
}

function wifiState(name, detail) {
  const text = {
    connecting: "Connecting to the bridge…",
    open: "Bridge connected, waiting for the QZ1",
    "qz1-connected": `Bridge connected${detail?.deviceName ? ` · ${detail.deviceName}` : ""}`,
    "qz1-disconnected": "Bridge connected, but it has no link to the QZ1",
    retrying: "Bridge not reachable, retrying (is this phone on its Wi-Fi?)",
    error: "Could not open the connection",
    closed: "Not connected"
  }[name] ?? name;
  bridgeText = text;
  if (name === "open" || name === "qz1-connected" || name === "qz1-disconnected") { setConnected(true); keepAwake(); }
  if (name === "closed") setConnected(false);
}

function bleState(name, detail) {
  const text = {
    choosing: "Choose the bridge in the list…",
    connecting: "Connecting…",
    connected: "Connected over Bluetooth",
    disconnected: "Not connected",
    cancelled: "Cancelled",
    unsupported: "This browser has no Web Bluetooth",
    error: `Could not connect${detail?.message ? `: ${detail.message}` : ""}`
  }[name] ?? name;
  bridgeText = text;
  if (name === "connected") { setConnected(true); keepAwake(); }
  if (["disconnected", "cancelled", "error", "unsupported"].includes(name)) setConnected(false);
}

$("connectWifi").addEventListener("click", () => {
  transport?.disconnect?.();
  state.reset();
  transport = new WifiTransport({ url: wifiUrl, onLine, onState: wifiState });
  transport.connect();
});

$("connectBle").addEventListener("click", async () => {
  transport?.disconnect?.();
  state.reset();
  transport = new BleTransport({ onLine, onState: bleState });
  try {
    await transport.connect();
  } catch {
    // bleState already said what went wrong
  }
});

$("disconnect").addEventListener("click", () => {
  transport?.disconnect?.();
  wakeLock?.release?.().catch?.(() => {});
});

$("recStart").addEventListener("click", () => {
  recording = [];
  $("recStart").disabled = true; $("recStop").disabled = false; $("recSave").disabled = true;
});
$("recStop").addEventListener("click", () => {
  recorded = recording ?? [];
  recording = null;
  $("recStart").disabled = false; $("recStop").disabled = true; $("recSave").disabled = recorded.length === 0;
  $("recInfo").textContent = `${recorded.length} lines recorded. Save them as a .nmea file.`;
});
$("recSave").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`${recorded.join("\n")}\n`], { type: "text/plain" }));
  link.download = `qz1-${stamp}.nmea`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});

// ---- drawing -----------------------------------------------------------------------------------

const COLORS = { QZSS: "#d9534f", GPS: "#0b6bcb", GLONASS: "#8e44ad", Galileo: "#1a7f37", BeiDou: "#b35900", Other: "#888888" };
const SVG = "http://www.w3.org/2000/svg";

function svgEl(name, attrs, text) {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawSky(satellites) {
  const sky = $("sky");
  sky.replaceChildren();
  const ring = { fill: "none", stroke: "currentColor", "stroke-opacity": "0.25" };
  for (const r of [30, 60, 90]) sky.append(svgEl("circle", { cx: 0, cy: 0, r, ...ring }));
  sky.append(svgEl("line", { x1: -90, y1: 0, x2: 90, y2: 0, ...ring }), svgEl("line", { x1: 0, y1: -90, x2: 0, y2: 90, ...ring }));
  for (const [label, x, y] of [["N", 0, -97], ["E", 98, 4], ["S", 0, 104], ["W", -98, 4]]) {
    sky.append(svgEl("text", { x, y, "text-anchor": "middle", "font-size": 10, fill: "currentColor", "fill-opacity": "0.7" }, label));
  }
  for (const sat of satellites) {
    if (sat.elevation === null || sat.azimuth === null) continue;
    const radius = (90 - sat.elevation) * 1.0;                  // centre = overhead
    const angle = (sat.azimuth * Math.PI) / 180;                // clockwise from north
    const x = radius * Math.sin(angle);
    const y = -radius * Math.cos(angle);
    sky.append(svgEl("circle", { cx: x, cy: y, r: 8, fill: COLORS[sat.constellation], "fill-opacity": sat.used ? 1 : 0.4, stroke: sat.used ? "currentColor" : "none", "stroke-width": 1.5 }));
    sky.append(svgEl("text", { x, y: y + 3, "text-anchor": "middle", "font-size": 8, fill: "#fff" }, String(sat.prn)));
  }
}

function drawSnr(satellites) {
  const box = $("snr");
  box.replaceChildren();
  for (const sat of satellites) {
    const row = document.createElement("div");
    row.className = "snr";
    const name = document.createElement("span");
    name.textContent = `${sat.constellation === "Other" ? "?" : sat.constellation.slice(0, 4)} ${sat.prn}`;
    const bar = document.createElement("div");
    bar.className = `bar${sat.used ? " used" : ""}`;
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, ((sat.snr ?? 0) / 55) * 100))}%`;
    bar.append(fill);
    const value = document.createElement("span");
    value.textContent = sat.snr === null ? "-" : String(sat.snr);
    row.append(name, bar, value);
    box.append(row);
  }
}

function fmt(value, digits, unit = "") {
  return value === null || value === undefined ? "-" : `${value.toFixed(digits)}${unit}`;
}

function render() {
  const snap = state.snapshot();
  const fix = snap.fix;
  const receiving = Date.now() - lastLineAt < 3000;
  $("state").textContent = receiving ? `receiving ${linesPerSecond.toFixed(0)} lines/s` : (bridgeText || "not connected");
  const badge = $("badge");
  if (!fix) {
    badge.textContent = receiving ? "Waiting for a fix…" : "No data yet";
    badge.className = "badge";
  } else {
    badge.textContent = fix.qualityLabel + (fix.hdop !== null ? ` · HDOP ${fix.hdop}` : "");
    badge.className = `badge ${fix.quality === 0 ? "bad" : fix.quality === 1 ? "warn" : "good"}`;
  }
  $("lat").textContent = fmt(fix?.lat ?? null, 7, "°");
  $("lon").textContent = fmt(fix?.lon ?? null, 7, "°");
  $("alt").textContent = fmt(fix?.altitude ?? null, 1, " m");
  $("motion").textContent = snap.motion ? `${fmt(snap.motion.speedKmh, 1, " km/h")} · ${fmt(snap.motion.courseDeg, 0, "°")}` : "-";
  $("sats").textContent = fix ? `${fix.satellitesUsed ?? "-"} used · ${snap.satellites.length} in view` : "-";
  $("hdop").textContent = fmt(snap.dop.hdop, 1);
  $("utc").textContent = fix?.utc ? fix.utc.replace(/^(\d\d)(\d\d)(\d\d).*/, "$1:$2:$3") : "-";
  $("age").textContent = snap.fixAgeMs === null ? "-" : `${(snap.fixAgeMs / 1000).toFixed(1)} s ago`;
  drawSky(snap.satellites);
  drawSnr(snap.satellites);
  $("raw").textContent = rawTail.slice(-12).join("\n");
  if (recording) $("recInfo").textContent = `Recording… ${recording.length} lines`;
}

setInterval(() => {
  linesPerSecond = linesInWindow;
  linesInWindow = 0;
}, 1000);
setInterval(render, 250);

// ---- first-screen help ------------------------------------------------------------------------------

$("connectBle").hidden = !bleOk;
$("connectWifi").hidden = !wifiUrl;
if (!bleOk && !wifiUrl) {
  $("help").textContent = "This browser cannot connect to the bridge from here. iPhone: open this page in Bluefy (a free browser with Web Bluetooth), or join the bridge's Wi-Fi and open http://192.168.4.1/ in Safari. Android / PC: use Chrome.";
} else if (wifiUrl && !bleOk) {
  $("help").textContent = "Connect to the bridge over its Wi-Fi. (Bluetooth needs Chrome or Bluefy and an https page.)";
} else if (bleOk && !wifiUrl) {
  $("help").textContent = "Press Connect and pick the bridge in the list. (For Safari, join the bridge's Wi-Fi and open http://192.168.4.1/ instead.)";
}
render();
