import test from "node:test";
import assert from "node:assert/strict";
import { startFakeCore2, SAMPLE_EPOCH } from "../tools/fake-core2.mjs";
import { GnssState } from "../web/nmea.js";

// Node 22+ has a global WebSocket client.
function collect(url, ms) {
  return new Promise((resolve) => {
    const frames = [];
    const socket = new WebSocket(url);
    socket.onmessage = (event) => frames.push(event.data);
    setTimeout(() => { socket.close(); resolve(frames); }, ms);
  });
}

test("the fake bridge sends a status frame, then CR LF terminated NMEA the parser understands", async () => {
  const fake = await startFakeCore2({ intervalMs: 20 });
  try {
    const frames = await collect(`ws://127.0.0.1:${fake.wsPort}/`, 400);
    assert.deepEqual(JSON.parse(frames[0]), { type: "status", state: "connected", deviceName: "QZ1" });
    const lines = frames.slice(1);
    assert.ok(lines.length >= 5);
    assert.ok(lines.every((frame) => frame.endsWith("\r\n")));
    const state = new GnssState();
    for (const frame of lines) state.push(frame);
    assert.equal(state.snapshot().fix.quality, 2);
    assert.ok(SAMPLE_EPOCH.includes(lines[0].trim()));
  } finally {
    await fake.close();
  }
});

test("the fake bridge says when the QZ1 link drops, and serves the viewer over http", async () => {
  const fake = await startFakeCore2({ intervalMs: 20 });
  try {
    const page = await fetch(`http://127.0.0.1:${fake.httpPort}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /QZ1 iPhone viewer/);
    assert.equal(await (await fetch(`http://127.0.0.1:${fake.httpPort}/ping`)).text(), "ok");
    const collecting = collect(`ws://127.0.0.1:${fake.wsPort}/`, 500);
    await new Promise((r) => setTimeout(r, 200));
    fake.setQz1Connected(false);
    const frames = await collecting;
    assert.ok(frames.some((f) => f.includes('"state":"disconnected"')));
  } finally {
    await fake.close();
  }
});
