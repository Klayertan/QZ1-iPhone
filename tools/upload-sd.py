#!/usr/bin/env python3
"""Copy a packed app folder to the Core2's SD card over the USB cable (no card reader).

    node tools/pack-sd.mjs                               # makes dist/www
    python tools/upload-sd.py /dev/cu.usbserial-XXXX [dist/www]

Needs `pip install pyserial` and the Core2 running this repo's firmware. It replaces
everything under /www on the card, checks every file with a CRC32 and retries a bad one.
Protocol: see "File transfer over USB serial" in firmware/src/main.cpp and docs/protocol.md.
"""

from __future__ import annotations

import sys
import time
import zlib
from pathlib import Path

import serial

CHUNK = 1024
FAST_BAUD = 460800
NORMAL_BAUD = 115200


def read_reply(port: serial.Serial, timeout: float = 15.0) -> str:
    """Next line that starts with '@' (everything else on the line is the device's log)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = port.readline()
        if not raw:
            continue
        text = raw.decode("utf-8", "replace").strip()
        if "@" in text:
            return text[text.index("@") + 1 :]
    raise TimeoutError("no answer from the Core2")


def command(port: serial.Serial, text: str, timeout: float = 15.0) -> str:
    port.reset_input_buffer()
    port.write(f"{text}\n".encode())
    port.flush()
    return read_reply(port, timeout)


def wait_until_ready(port: serial.Serial, seconds: float = 25.0) -> None:
    """Opening the port can reset the board: ping until it answers a command."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        port.reset_input_buffer()
        port.write(b"\n@PING\n")
        port.flush()
        end = time.time() + 1.5
        while time.time() < end:
            raw = port.readline()
            if raw and b"@" in raw:
                return
    raise TimeoutError("the Core2 does not answer: is it running this repo's firmware?")


def put(port: serial.Serial, local: Path, remote: str) -> None:
    data = local.read_bytes()
    crc = zlib.crc32(data) & 0xFFFFFFFF
    for attempt in range(3):
        answer = command(port, f"@PUT {len(data)} {crc:08x} {remote}")
        if answer != "READY":
            raise RuntimeError(f"{remote}: {answer}")
        failed = ""
        for offset in range(0, len(data), CHUNK):
            port.write(data[offset : offset + CHUNK])
            port.flush()
            answer = read_reply(port, 15)
            if answer != "A":
                failed = answer
                break
        else:
            answer = read_reply(port, 15)
            if answer.startswith("DONE"):
                return
            failed = answer
        print(f"   retry {remote}: {failed}")
        time.sleep(0.5)
    raise RuntimeError(f"{remote}: gave up after 3 attempts")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    device = sys.argv[1]
    folder = Path(sys.argv[2] if len(sys.argv) > 2 else "dist/www")
    files = sorted(path for path in folder.rglob("*") if path.is_file())
    if not files:
        print(f"nothing to send in {folder}")
        return 1
    total = sum(path.stat().st_size for path in files)

    port = serial.Serial()
    port.port = device
    port.baudrate = NORMAL_BAUD
    port.timeout = 1
    port.dtr = False  # do not reset the board by opening the port
    port.rts = False
    port.open()
    try:
        print(f"{len(files)} files, {total / 1024:.0f} KB -> {device}")
        wait_until_ready(port)
        if command(port, f"@BAUD {FAST_BAUD}") != "OK":
            raise RuntimeError("could not switch speed")
        port.baudrate = FAST_BAUD
        time.sleep(0.3)
        if command(port, "@WIPE /www", 60) != "OK":
            raise RuntimeError("could not clear /www (is the SD card in?)")
        sent = 0
        started = time.time()
        for index, path in enumerate(files, 1):
            remote = "/www/" + path.relative_to(folder).as_posix()
            put(port, path, remote)
            sent += path.stat().st_size
            if index % 10 == 0 or index == len(files):
                rate = sent / max(time.time() - started, 0.1) / 1024
                print(f"  {index}/{len(files)} files, {sent / 1024:.0f}/{total / 1024:.0f} KB ({rate:.0f} KB/s)")
        port.reset_input_buffer()
        port.write(b"@BAUD 115200\n")
        port.flush()
        read_reply(port)
        port.baudrate = NORMAL_BAUD
        time.sleep(0.3)
        print(command(port, "@END"))
    finally:
        port.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
