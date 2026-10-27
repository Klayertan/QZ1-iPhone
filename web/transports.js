// The two ways a phone browser can receive the bridge's NMEA. No dependencies.
//
//   WifiTransport : WebSocket to the bridge's own Wi-Fi network (ws://192.168.4.1:81/).
//                   Works in any browser, including Safari on iPhone, but only from a page the
//                   bridge itself serves over plain http (an https page may not open ws://).
//   BleTransport  : Web Bluetooth to the bridge's Nordic-UART-style service. Needs a browser with
//                   Web Bluetooth (Chrome on Android/PC, Bluefy on iPhone) and an https page.
//
// Both hand complete NMEA lines to onLine(line). See docs/protocol.md.

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

/** Turns arbitrary text chunks into complete lines (a line may be split across chunks). */
export class LineSplitter {
  constructor(limit = 4096) {
    this.buffer = "";
    this.limit = limit;
  }

  push(text) {
    this.buffer += text;
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = parts.pop() ?? "";
    if (this.buffer.length > this.limit) this.buffer = ""; // no newline for ages: not NMEA, start over
    return parts.filter((line) => line.trim() !== "");
  }

  reset() {
    this.buffer = "";
  }
}

export class WifiTransport {
  constructor({ url, onLine, onState = () => {}, WebSocketImpl = globalThis.WebSocket, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
    Object.assign(this, { url, onLine, onState, WebSocketImpl, setTimeoutImpl, clearTimeoutImpl });
    this.socket = null;
    this.splitter = new LineSplitter();
    this.retryMs = 500;
    this.retryTimer = null;
    this.wanted = false;
  }

  connect() {
    this.wanted = true;
    this._open();
  }

  _open() {
    this.onState("connecting");
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.onState("error", { message: String(error?.message || error) });
      this._retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retryMs = 500;
      this.splitter.reset();
      this.onState("open"); // the bridge says right away whether the QZ1 is linked
    };
    socket.onmessage = (event) => this._message(typeof event.data === "string" ? event.data : "");
    socket.onerror = () => {};
    socket.onclose = () => {
      this.socket = null;
      if (this.wanted) {
        this.onState("retrying");
        this._retry();
      } else {
        this.onState("closed");
      }
    };
  }

  _message(text) {
    if (text.startsWith("{")) {
      try {
        const status = JSON.parse(text);
        if (status.type === "status") {
          this.onState(status.state === "connected" ? "qz1-connected" : "qz1-disconnected", status);
          return;
        }
      } catch {
        // not JSON after all: treat as text below
      }
    }
    for (const line of this.splitter.push(text)) this.onLine(line);
  }

  _retry() {
    if (!this.wanted || this.retryTimer !== null) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 8000);
    this.retryTimer = this.setTimeoutImpl(() => {
      this.retryTimer = null;
      if (this.wanted) this._open();
    }, wait);
  }

  disconnect() {
    this.wanted = false;
    if (this.retryTimer !== null) this.clearTimeoutImpl(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;   // we report the close ourselves, at once, not when the server answers
      socket.onmessage = null;
      if (socket.readyState < 2) socket.close();
    }
    this.onState("closed");
  }
}

export class BleTransport {
  constructor({ onLine, onState = () => {}, bluetooth = globalThis.navigator?.bluetooth, namePrefix = "" }) {
    Object.assign(this, { onLine, onState, bluetooth, namePrefix });
    this.splitter = new LineSplitter();
    this.decoder = new TextDecoder("utf-8");
    this.device = null;
    this.characteristic = null;
    this._changed = (event) => {
      const text = this.decoder.decode(event.target.value, { stream: true });
      for (const line of this.splitter.push(text)) this.onLine(line);
    };
    this._dropped = () => {
      this._cleanup();
      this.onState("disconnected");
    };
  }

  static supported(bluetooth = globalThis.navigator?.bluetooth, secure = globalThis.isSecureContext) {
    return Boolean(bluetooth) && secure !== false;
  }

  /** Opens the browser's device list and connects. Must be called from a click. */
  async connect() {
    if (!BleTransport.supported(this.bluetooth)) {
      this.onState("unsupported");
      throw new Error("This browser has no Web Bluetooth (or the page is not https).");
    }
    this.onState("choosing");
    const filter = { services: [NUS_SERVICE] };
    if (this.namePrefix) filter.namePrefix = this.namePrefix;
    let device;
    try {
      device = await this.bluetooth.requestDevice({ filters: [filter], optionalServices: [NUS_SERVICE] });
    } catch (error) {
      this.onState(error?.name === "NotFoundError" ? "cancelled" : "error", { message: String(error?.message || error) });
      throw error;
    }
    this.device = device;
    device.addEventListener?.("gattserverdisconnected", this._dropped);
    this.onState("connecting");
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      const characteristic = await service.getCharacteristic(NUS_NOTIFY);
      await characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", this._changed);
      this.characteristic = characteristic;
      this.splitter.reset();
      this.onState("connected");
    } catch (error) {
      this._cleanup();
      this.onState("error", { message: String(error?.message || error) });
      throw error;
    }
  }

  async disconnect() {
    const device = this.device;
    this._cleanup();
    try {
      device?.gatt?.disconnect();
    } catch {
      // already gone
    }
    this.onState("disconnected");
  }

  _cleanup() {
    try {
      this.characteristic?.removeEventListener("characteristicvaluechanged", this._changed);
      this.device?.removeEventListener?.("gattserverdisconnected", this._dropped);
    } catch {
      // ignore
    }
    this.characteristic = null;
    this.device = null;
    this.splitter.reset();
  }
}
