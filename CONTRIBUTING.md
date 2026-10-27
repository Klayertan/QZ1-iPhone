# Contributing

Test reports are the most useful thing right now: which iPhone and iOS version, which browser (Safari / Bluefy / Chrome),
which mode (Wi-Fi / Bluetooth), which receiver, and what happened. Open an issue; the serial log helps.

Code changes: keep the viewer dependency-free (plain ES modules), run `npm test` (Node 22+), and compile the firmware
(`cp firmware/src/config.example.h firmware/src/config.h && cd firmware && pio run`). Please say what you tested on real
hardware and what you did not.
