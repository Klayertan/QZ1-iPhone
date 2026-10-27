# Troubleshooting

Open the serial monitor first (`cd firmware && pio device monitor`, 115200). The Core2 prints what it is doing.
For the Bluetooth stack's own messages flash the debug build: `pio run -e m5stack-core2-debug -t upload`.

| Symptom | Likely cause / fix |
|---|---|
| Core2 screen says `QZ1: searching` for a long time, log shows `[bt] connect failed` | The QZ1 is off, out of range, **already connected to another device** (phone, computer, an app that auto-reconnects), or the address / name in `config.h` is wrong. Power-cycle the QZ1, turn off Bluetooth on other devices, read the `[bt] scan:` lines for the real name and address |
| `[bt] scan` does not list the QZ1 at all | It is not discoverable / busy. Same fixes. |
| Log shows the serial service found but pairing fails | Try the other PIN (`1234` / `0000`), or set `QZ1_USE_SSP 1` |
| Upload fails with "Invalid head of packet" | A noisy cable at high speed. `platformio.ini` already uses 460800; try 115200 or another cable |
| `[wifi]` fine but the iPhone's Safari "keeps loading" | The iPhone is not actually on the Core2's Wi-Fi (the status page shows `ap-stations=0` in the log). Settings → Wi-Fi: is the network ticked? Auto-Join on? "No Internet Connection" is normal |
| `http://192.168.4.1/ping` shows `ok` but `/` does not load | Is `/www` on the SD card? Open `/status` (`"site":"none"` means no viewer). Re-run `tools/pack-sd.mjs` and `tools/upload-sd.py` |
| The page shows garbage characters | An old firmware sent `Content-Encoding` twice (fixed). Reflash, and reload the page (the cache key changes per build) |
| Safari / Chrome on iPhone: no Bluetooth button | They have no Web Bluetooth. Use Bluefy, or the Wi-Fi mode |
| Bluefy loads nothing | Bluefy needs the internet to load an https page: turn the iPhone's Wi-Fi off (use mobile data), or host `web/` somewhere reachable |
| Connected but the status says "no link to the QZ1" | The Core2 is up but not linked to the QZ1; see the first row |
| No phone GPS / compass on the page | Expected on the Wi-Fi page (plain http). Use the https page with Bluetooth mode |
| ESP32-S3 / CoreS3 | Not supported (no Bluetooth Classic) |

Still stuck? Open an issue with the serial log (remove anything you do not want public, such as your QZ1's address).
