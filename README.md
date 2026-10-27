# QZ1 iPhone

**Use a Bluetooth GNSS receiver (the QZ1) with an iPhone.**

An iPhone cannot open the Bluetooth Classic serial link that receivers like the QZ1 use: Safari has no Web
Serial or Web Bluetooth, and Apple only lets apps talk to Bluetooth Classic accessories that went through its
MFi programme. This project puts a small **M5Stack Core2** next to the receiver. The Core2 does what the iPhone
cannot (it reads the QZ1 over Bluetooth Classic) and hands the NMEA to the phone in a way a browser *can* use:

```
                                        ┌─ Wi-Fi (its own network) ──> Safari, any browser   (plain http page, works offline)
QZ1 --Bluetooth Classic (SPP)--> Core2 ─┤
                                        └─ Bluetooth LE ─────────────> Bluefy / Chrome       (https page, Web Bluetooth)
```

No laptop, no cloud, no account. A dependency-free viewer page (position, fix quality, satellites, sky plot,
raw NMEA, recording to a `.nmea` file) is included, and the protocol is small and documented, so you can point
**your own app** at the Core2 instead ([docs/protocol.md](docs/protocol.md)).

It was built for [SuiSuiNavi](https://github.com/Klayertan/michibiki-suimon-navi), a rice-paddy water management
web app that measures field boundaries with QZSS (Michibiki), and is shared in case it helps someone else.

## Status (read this first)

This is a hobby project. What has actually been checked, and what has not:

| | |
|---|---|
| Core2 ↔ a real **QZ1** over Bluetooth Classic (found the serial service, ~8 NMEA lines/s) | **checked on real hardware**, one QZ1 unit and one Core2 |
| Core2 firmware: Wi-Fi access point, web page from the SD card, WebSocket, BLE advertising, USB file transfer | **checked on a real Core2**, using the same code as this repo's `firmware/`. Here the device names moved into `config.h` and the text became generic; that copy **compiles** (with and without an address / SSP config) but has **not been re-flashed** |
| End to end with an **iPhone** | the author reports it working; the exact iPhone / iOS version / route is **not recorded yet**. If you try it, please [open an issue](../../issues) with your result |
| The viewer page (this repo's `web/`) | tested in desktop Chromium against a fake bridge (Wi-Fi and Bluetooth paths); **not yet tested on a real iPhone** |
| Other receivers (any Bluetooth Classic SPP device that streams NMEA) | **untested**, should work in principle |
| Long runs | not tested beyond minutes; free memory is tight (see [docs/how-it-works.md](docs/how-it-works.md)) |

Nothing here is a survey-grade accuracy claim. The viewer shows what the receiver reports.

## What you need

- An **M5Stack Core2** (a classic ESP32). **Not the CoreS3**: the ESP32-S3 has no Bluetooth Classic and cannot talk to a QZ1. Tested on a Core2 with the AXP2101 power chip.
- A QZ1 (or another Bluetooth Classic NMEA receiver), switched on, **paired with nothing else** (it accepts one connection at a time).
- A USB-C cable. A microSD card (FAT32) only for the Wi-Fi mode. A power bank for the field.
- A Mac or PC with Python 3 and Node 22+.
- On the iPhone: Safari for the Wi-Fi mode, or [Bluefy](https://apps.apple.com/app/id1492822055) (a free browser that adds Web Bluetooth) for the Bluetooth mode. Chrome on iPhone is **not** enough: every iOS browser runs on Apple's WebKit, which has no Web Bluetooth.

## Quick start

```bash
git clone https://github.com/Klayertan/QZ1-iPhone.git && cd QZ1-iPhone
npm test                                   # 18 tests, no dependencies

# 1. Flash the Core2
pip install platformio
cp firmware/src/config.example.h firmware/src/config.h      # then edit it (below)
cd firmware && pio run -t upload && cd ..

# 2. Put the viewer on the Core2 (Wi-Fi mode only), over the USB cable
node tools/pack-sd.mjs
pip install pyserial
python tools/upload-sd.py /dev/cu.usbserial-XXXX             # your Core2's serial port
```

Edit `firmware/src/config.h`: the QZ1's Bluetooth **address** (macOS: System Information → Bluetooth;
Linux: `bluetoothctl devices`) or its **name**, and the pairing **PIN** (`1234` worked for the QZ1 used here,
some units use `0000`). If you do not know the address, flash first and read `pio device monitor`: the Core2
prints a `[bt] scan:` list of what it can see.

### Use it with Safari (Wi-Fi mode, the default)

1. The Core2 starts on its status page; press **A** for a Wi-Fi QR code (name `QZ1-Bridge-XXXX`, random password
   made on first start and kept in flash). Scan it with the iPhone camera and join. "No Internet Connection" is expected.
2. Open `http://192.168.4.1/` in Safari. Press **Connect (bridge Wi-Fi)**.

This page is plain http, so iOS gives it **no phone GPS, no compass and no screen wake lock** (browser rules for non-https pages): set Auto-Lock to Never.

### Use it with Bluefy (Bluetooth mode)

1. Hold button **B** on the Core2 for 2 seconds. It restarts in **Bluetooth mode** (Wi-Fi off). Hold again to go back.
2. On the iPhone open the viewer over **https** in Bluefy (host `web/` on GitHub Pages, see below) and press **Connect (Bluetooth)**; pick the bridge from the list. Do not pair it in iOS Settings.

Because the page is https, your own page can also use the phone's GPS and compass in this mode.

### Host the viewer on GitHub Pages

The `Pages` workflow publishes `web/` (run it from the Actions tab after enabling Settings → Pages → Source: GitHub Actions).
You can host `web/` anywhere that serves https.

## Buttons on the Core2

| | |
|---|---|
| **A** | next screen (status, Wi-Fi QR, address QR; Wi-Fi mode only) |
| **B** (click) | reconnect to the QZ1 |
| **B** (hold 2 s) | switch between Wi-Fi mode and Bluetooth mode (the Core2 restarts) |
| **C** | screen off / on |

Only one of the two phone-facing modes runs at a time: with both plus the Classic link to the QZ1 and the web server,
the Core2 ran out of memory and could not even serve the page.

## Layout

| | |
|---|---|
| `firmware/` | PlatformIO project (Arduino-ESP32): Classic Bluetooth client, Wi-Fi AP + HTTP + WebSocket, BLE UART notifier, USB file transfer |
| `web/` | the viewer: `index.html`, `app.js`, `nmea.js` (parser), `transports.js` (Wi-Fi and Bluetooth), no dependencies |
| `tools/` | `pack-sd.mjs`, `upload-sd.py`, `fake-core2.mjs` (a stand-in bridge: `npm run fake`, open http://127.0.0.1:4180/?ws=ws://127.0.0.1:4181/) |
| `test/` | `npm test` (Node's built-in runner) |
| `docs/` | [protocol](docs/protocol.md), [how it works](docs/how-it-works.md), [troubleshooting](docs/troubleshooting.md) |

## Licence

MIT, see [LICENSE](LICENSE). The firmware is built with Arduino-ESP32 and arduinoWebSockets (both LGPL-2.1) and
M5Unified / M5GFX (MIT); the viewer has no third-party code. Map tiles are not used.
Contributions and test reports are welcome ([CONTRIBUTING.md](CONTRIBUTING.md)).
