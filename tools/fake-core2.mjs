// A stand-in for the Core2 bridge (firmware/), for tests and for trying the viewer without hardware:
//
//   node tools/fake-core2.mjs [httpPort] [wsPort]      then open http://127.0.0.1:4180/
//
// It does what the real device does, minus Bluetooth:
//   * HTTP  : serves web/ (or a packed folder, the way the firmware serves the SD card);
//   * WebSocket: a status frame on connect ({"type":"status","state":"connected"|
//             "disconnected","deviceName":"QZ1"}), then synthetic NMEA as text
//             frames that END IN A NEWLINE (the page's transport splits on newlines).
//
// Plain node (no dependencies): a minimal RFC 6455 server, text frames only.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

/** "$" + body + "*" + checksum, so the page's checksum counter has nothing to flag. */
export function nmeaSentence(body) {
  let checksum = 0;
  for (const character of body) checksum ^= character.charCodeAt(0);
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
}

export const SAMPLE_EPOCH = [
  "GPGSV,2,1,06,07,45,120,38,08,30,200,27,10,60,010,41,13,15,300,",
  "GPGSV,2,2,06,193,70,180,44,194,12,045,20",
  "GNGSA,A,3,07,10,193,,,,,,,,,,1.2,0.9,0.8",
  "GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,",
  "GNRMC,012345.00,A,3439.2705,N,13549.8410,E,1.00,90.0,120726,,,D"
].map(nmeaSentence);

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  } else {
    throw new Error("frame too large for this fake");
  }
  return Buffer.concat([header, payload]);
}

/** Enough of a frame parser to notice close and answer ping; client data is ignored. */
function handleClientBytes(socket, chunk) {
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const opcode = chunk[offset] & 0x0f;
    let length = chunk[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > chunk.length) return;
      length = chunk.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      return; // not used by a browser here
    }
    const masked = (chunk[offset + 1] & 0x80) !== 0;
    const total = headerLength + (masked ? 4 : 0) + length;
    if (offset + total > chunk.length) return;
    if (opcode === 0x8) {
      socket.end(Buffer.from([0x88, 0x00]));
      return;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]));
    }
    offset += total;
  }
}

/**
 * @returns {Promise<{httpPort:number, wsPort:number, setQz1Connected(on:boolean):void,
 *                    clientCount():number, close():Promise<void>}>}
 */
export async function startFakeCore2({
  root = resolve(fileURLToPath(new URL("../web", import.meta.url))),
  httpPort = 0,
  wsPort = 0,
  lines = SAMPLE_EPOCH,
  intervalMs = 80,
  qz1Connected = true,
  deviceName = "QZ1",
  wwwDir = null   // a folder made by tools/pack-sd.mjs: served the way the firmware serves the SD card
} = {}) {
  const clients = new Set();
  let qz1On = qz1Connected;
  let index = 0;
  let wsPortActual = wsPort;

  const statusFrame = () => encodeTextFrame(JSON.stringify({ type: "status", state: qz1On ? "connected" : "disconnected", deviceName }));

  const wsServer = createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("WebSocket only");
  });
  wsServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    clients.add(socket);
    socket.write(statusFrame());
    socket.on("data", (chunk) => handleClientBytes(socket, chunk));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  const timer = setInterval(() => {
    if (!qz1On || clients.size === 0) return;
    const frame = encodeTextFrame(`${lines[index % lines.length]}\r\n`);
    index += 1;
    for (const socket of clients) socket.write(frame);
  }, intervalMs);

  const httpServer = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (urlPath === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      const relative = normalize(urlPath).replace(/^([/\\]|\.\.)+/, "");
      if (wwwDir) {
        // Like the firmware: name.gz is preferred (sent with Content-Encoding: gzip),
        // the ETag is version.txt, and an unchanged file is a 304.
        const name = relative === "" || urlPath.endsWith("/") ? `${relative}index.html` : relative;
        const plain = join(wwwDir, name);
        const zipped = `${plain}.gz`;
        const gzip = existsSync(zipped);
        if (!gzip && !existsSync(plain)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
          return;
        }
        const version = existsSync(join(wwwDir, "version.txt")) ? (await readFile(join(wwwDir, "version.txt"), "utf8")).trim() : "none";
        const etag = `"${version}"`;
        const headers = { "Content-Type": TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache", ETag: etag };
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        if (gzip) headers["Content-Encoding"] = "gzip";
        res.writeHead(200, headers);
        res.end(await readFile(gzip ? zipped : plain));
        return;
      }
      const filePath = join(root, relative === "" || urlPath.endsWith("/") ? `${relative}index.html` : relative);
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  await new Promise((done) => wsServer.listen(wsPort, "127.0.0.1", done));
  wsPortActual = wsServer.address().port;
  await new Promise((done) => httpServer.listen(httpPort, "127.0.0.1", done));

  return {
    httpPort: httpServer.address().port,
    wsPort: wsPortActual,
    setQz1Connected(on) {
      qz1On = Boolean(on);
      const frame = statusFrame();
      for (const socket of clients) socket.write(frame);
    },
    clientCount: () => clients.size,
    async close() {
      clearInterval(timer);
      for (const socket of clients) socket.destroy();
      await Promise.all([
        new Promise((done) => httpServer.close(done)),
        new Promise((done) => wsServer.close(done))
      ]);
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [httpArg, wsArg] = process.argv.slice(2).map(Number);
  const fake = await startFakeCore2({ httpPort: httpArg || 4180, wsPort: wsArg || 4181 });
  console.log(`fake Core2: app on http://127.0.0.1:${fake.httpPort}/  websocket on ws://127.0.0.1:${fake.wsPort}/`);
}
