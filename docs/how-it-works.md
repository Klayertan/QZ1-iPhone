# How it works

## Why a bridge at all

A QZ1-class receiver streams NMEA over **Bluetooth Classic (SPP / RFCOMM)**. On Android Chrome and desktop Chrome the
Web Serial API can open such a port. On an iPhone nothing can: Safari has no Web Serial or Web Bluetooth, every other iOS
browser is Apple's WebKit underneath, and native apps can only use Bluetooth Classic accessories in Apple's MFi programme.
Bluetooth *LE* is different: iOS apps can use it, and a few browsers (Bluefy, WebBLE) add Web Bluetooth on top of it.

So the Core2 sits next to the receiver and translates: Bluetooth Classic on one side, and on the other side either a
WebSocket over its own Wi-Fi (works in plain Safari) or a Bluetooth LE notify characteristic (works in a Web Bluetooth browser).

## The two phone-facing modes, and why only one runs at a time

| | Wi-Fi mode | Bluetooth LE mode |
|---|---|---|
| Page comes from | the Core2's SD card, `http://192.168.4.1/` | anywhere over **https** |
| Works in | any browser | Chrome (Android / PC), Bluefy (iPhone) |
| Phone GPS / compass / wake lock in the page | **no**: browsers give these to https pages only (iOS Safari answers `PERMISSION_DENIED` on http) | yes, because the page is https |
| Internet needed | no | only to load the page |

An https page may not open a plain `ws://` connection to a device (mixed content), and a device on a private network cannot get a
trusted certificate, which is why Wi-Fi mode needs its own http page.

Running Classic Bluetooth, BLE, Wi-Fi and the web server together left about 21 KB of free internal RAM with a 4 KB largest block,
and loading the viewer failed. One mode at a time (hold **B** for 2 s to switch; the choice is kept in flash) leaves about 31-35 KB.
The line queue is only 12 slots of 124 bytes for the same reason.

## Firmware outline (`firmware/src/main.cpp`)

- A **Bluetooth task** (core 0) keeps trying to connect to the QZ1 (by address if configured, otherwise by name), reads bytes into a fixed buffer,
  and queues complete `$...` lines. A failed connect backs off 2.5 s; a scan of nearby devices is printed on attempt 2 and every 30th.
- The **main loop** serves HTTP and the WebSocket (Wi-Fi mode) or notifies the BLE client (Bluetooth mode), draws the screen, and handles the buttons.
- A random Wi-Fi password is made on first start and kept in flash (`Preferences`); nothing secret is in the source.
- The USB-serial file transfer lets the viewer be copied to the SD card with no card reader.

## Things we learned the hard way

- `WebServer::streamFile()` already adds `Content-Encoding: gzip` for a `*.gz` file. Adding it again sent the header twice and Safari
  showed the compressed bytes as text.
- Each QZ1 unit has its own name and address (`QZ1-xxx`); the one that is paired with your Mac may not be the one that is switched on.
- The QZ1 accepts one connection: a phone or computer that auto-reconnects to it will make the Core2's attempts time out.
- Connecting by Bluetooth address needs an SDP lookup first; that is automatic, and the QZ1's serial service is on RFCOMM channel 1.
