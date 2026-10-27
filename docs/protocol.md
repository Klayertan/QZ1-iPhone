# Protocol

Everything the Core2 sends is NMEA 0183 text exactly as the QZ1 produced it (only lines that start with `$`,
at most 120 characters, are passed on). A phone sends nothing.

## Wi-Fi mode

The Core2 is an access point, `192.168.4.1`, WPA2 with a random password made on first start (shown on screen).

| Port | What |
|---|---|
| 80 | HTTP: the viewer from the SD card (`/www`, `name.gz` preferred and sent with one `Content-Encoding: gzip`, `ETag` = `version.txt` + firmware build time). `/ping` → `ok`. `/status` → JSON (`qz1`, `lines`, `phones`, `freeHeap`, `site`). `/config/local-device.js` → one line that sets `window.SUISUI_LOCAL_DEVICE_WS` to `ws://<host>:81/` (for apps that want it) |
| 81 | WebSocket (text frames) |

WebSocket frames:

- On connect, and whenever the QZ1 link changes: `{"type":"status","state":"connected"|"disconnected","deviceName":"QZ1-xxx"}`.
- Then every NMEA line as one text frame **ending in CR LF** (clients split on newlines and tolerate a line cut across frames).
- Heartbeat pings every 15 s; up to 4 phones on the access point.

## Bluetooth LE mode

Wi-Fi is off. The Core2 advertises as `DEVICE_NAME` (default `QZ1-Bridge`) with a Nordic-UART-style service:

| | UUID |
|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| Notify characteristic | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

Each NMEA line plus CR LF is sent as one or more notifications of at most `MTU - 3` bytes (the Core2 asks for MTU 185;
20 bytes until the phone negotiates more), so **reassemble across notifications**. There is no status frame in this mode:
if the QZ1 link is down, no lines arrive. Web Bluetooth wants lowercase UUID strings.

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"] }],
  optionalServices: ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"]
});
const server = await device.gatt.connect();
const service = await server.getPrimaryService("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
const notify = await service.getCharacteristic("6e400003-b5a3-f393-e0a9-e50e24dcca9e");
await notify.startNotifications();
notify.addEventListener("characteristicvaluechanged", (e) => handleChunk(new TextDecoder().decode(e.target.value, { stream: true })));
```

`web/transports.js` is a complete implementation of both modes.

## USB serial (115200 baud, any mode)

Plain text log lines (`[bt]`, `[ble]`, `[ws]`, `[http]`, `[stats]`, ...) and, for copying the viewer to the SD card without
a card reader, lines that start with `@` (everything else is ignored, and logging goes quiet during a transfer):

| Command | Does |
|---|---|
| `@PING` | any `@` reply (used to wait for the board after a reset) |
| `@BAUD n` | reply `@OK` at the old speed, then switch to `n` |
| `@WIPE /www` | delete a folder (only under `/www`) → `@OK` |
| `@PUT size crc32hex /www/path` | → `@READY`; then `size` raw bytes in chunks of up to 1024, the Core2 answering `@A` after each chunk, then `@DONE size` or `@ERR text`. CRC32 is the zlib one |
| `@END` | reload the version → `@OK site <version>` |

`tools/upload-sd.py` speaks this.
