import test from "node:test";
import assert from "node:assert/strict";
import { LineSplitter, WifiTransport, BleTransport, NUS_SERVICE, NUS_NOTIFY } from "../web/transports.js";

test("LineSplitter joins a line split across chunks and drops blank lines", () => {
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push("$GNGGA,1,2"), []);
  assert.deepEqual(splitter.push(",3*00\r\n$GNRMC,4"), ["$GNGGA,1,2,3*00"]);
  assert.deepEqual(splitter.push("\r\n\r\n"), ["$GNRMC,4"]);
});

test("LineSplitter gives up on a runaway line without a newline", () => {
  const splitter = new LineSplitter(100);
  assert.deepEqual(splitter.push("x".repeat(500)), []);
  assert.deepEqual(splitter.push("$A\n"), ["$A"]);
});

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  say(data) { this.onmessage?.({ data }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

test("WifiTransport: status frames become states, NMEA frames become lines", () => {
  FakeSocket.all = [];
  const states = [];
  const lines = [];
  const wifi = new WifiTransport({ url: "ws://192.168.4.1:81/", onLine: (l) => lines.push(l), onState: (s, d) => states.push([s, d?.deviceName]), WebSocketImpl: FakeSocket });
  wifi.connect();
  const socket = FakeSocket.all[0];
  assert.equal(socket.url, "ws://192.168.4.1:81/");
  socket.open();
  socket.say('{"type":"status","state":"connected","deviceName":"QZ1"}');
  socket.say("$GNGGA,a*00\r\n");
  socket.say("$GNRMC,b*00\r\n$GNG");
  socket.say("SA,c*00\r\n");
  socket.say('{"type":"status","state":"disconnected"}');
  assert.deepEqual(lines, ["$GNGGA,a*00", "$GNRMC,b*00", "$GNGSA,c*00"]);
  assert.deepEqual(states.map(([s]) => s), ["connecting", "open", "qz1-connected", "qz1-disconnected"]);
  assert.equal(states[2][1], "QZ1");
});

test("WifiTransport retries with a growing delay after a drop, and stops when told to", () => {
  FakeSocket.all = [];
  const timers = [];
  const states = [];
  const wifi = new WifiTransport({
    url: "ws://x/", onLine() {}, onState: (s) => states.push(s), WebSocketImpl: FakeSocket,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl() {}
  });
  wifi.connect();
  FakeSocket.all[0].close();            // never opened: server unreachable
  assert.equal(timers[0].ms, 500);
  timers[0].fn();
  FakeSocket.all[1].close();
  assert.equal(timers[1].ms, 1000);
  assert.ok(states.includes("retrying"));
  wifi.disconnect();
  assert.equal(states.at(-1), "closed");
});

test("BleTransport: requests the Nordic UART service and reassembles lines from 20-byte notifications", async () => {
  const handlers = new Map();
  const characteristic = {
    async startNotifications() {},
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: (type) => handlers.delete(type)
  };
  const device = {
    gatt: {
      connected: false,
      async connect() { this.connected = true; return { getPrimaryService: async (uuid) => { assert.equal(uuid, NUS_SERVICE); return { getCharacteristic: async (c) => { assert.equal(c, NUS_NOTIFY); return characteristic; } }; } }; },
      disconnect() { this.connected = false; }
    },
    addEventListener() {}, removeEventListener() {}
  };
  let request = null;
  const bluetooth = { requestDevice: async (options) => { request = options; return device; } };
  const lines = [];
  const states = [];
  const ble = new BleTransport({ bluetooth, onLine: (l) => lines.push(l), onState: (s) => states.push(s) });
  await ble.connect();
  assert.deepEqual(request.filters, [{ services: [NUS_SERVICE] }]);
  assert.deepEqual(states, ["choosing", "connecting", "connected"]);
  const text = "$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44\r\n";
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 20) {
    handlers.get("characteristicvaluechanged")({ target: { value: new DataView(bytes.slice(i, i + 20).buffer) } });
  }
  assert.deepEqual(lines, [text.trim()]);
  await ble.disconnect();
  assert.equal(states.at(-1), "disconnected");
});

test("BleTransport: a cancelled chooser is reported as cancelled, no Web Bluetooth as unsupported", async () => {
  const states = [];
  const cancelled = new BleTransport({
    bluetooth: { requestDevice: async () => { const e = new Error("User cancelled"); e.name = "NotFoundError"; throw e; } },
    onLine() {}, onState: (s) => states.push(s)
  });
  await assert.rejects(cancelled.connect());
  assert.equal(states.at(-1), "cancelled");
  const none = new BleTransport({ bluetooth: undefined, onLine() {}, onState: (s) => states.push(s) });
  await assert.rejects(none.connect(), /Web Bluetooth/);
  assert.equal(states.at(-1), "unsupported");
});
