// QZ1 iPhone: M5Stack Core2 bridge.
//
//   QZ1 --Bluetooth Classic (SPP)--> this Core2 --its own Wi-Fi--> phone browser
//
// * Bluetooth: connects to the paired QZ1 as the master and reads NMEA lines
//   (a separate task, because connecting can block for seconds).
// * Wi-Fi: an access point with a fixed address, 192.168.4.1. The password is
//   random, made on first start, kept in flash and shown on the screen.
// * HTTP (port 80): serves the viewer from the SD card (/www, see tools/pack-sd.mjs), plus
//   /ping and /status for debugging, and /config/local-device.js (a one-line script that
//   names the WebSocket, for apps that want it).
// * WebSocket (port 81): a status frame on connect and whenever the QZ1 link
//   changes ({"type":"status","state":"connected"|"disconnected","deviceName":..}),
//   then every NMEA line as a text frame that ENDS IN CR LF (the page splits on
//   newlines). Same protocol as the Android bridge, so the page's transport is shared.
//
// * Bluetooth LE (Nordic UART style service, notify): the same NMEA lines for a phone
//   browser with Web Bluetooth (Bluefy on iPhone, Chrome on Android/desktop), so the
//   https page can connect and keep the phone's GPS features. See docs/protocol.md.
//
// The README lists what has and has not been tested.
#include <M5Unified.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <BluetoothSerial.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <SPI.h>
#include <SD.h>

#include "config.h"

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error "Bluetooth is not enabled for this board. The blue QZ1 needs Bluetooth Classic: use a classic ESP32 (Core2), not an S3."
#endif

namespace {

constexpr int kHttpPort = 80;
constexpr int kWsPort = 81;
constexpr size_t kMaxLine = 120;           // NMEA is at most 82 characters; longer lines are dropped
constexpr uint8_t kSdChipSelect = 4;       // Core2 SD slot
constexpr uint32_t kRateWindowMs = 2000;

// While a file transfer (tools/upload-sd.py) owns the serial line, logging stays quiet.
volatile bool serialQuiet = false;
#define LOGLN(text) do { if (!serialQuiet) Serial.println(text); } while (0)
#define LOGF(...) do { if (!serialQuiet) Serial.printf(__VA_ARGS__); } while (0)

struct Line {
  char text[kMaxLine + 4];
};

BluetoothSerial serialBt;
WebServer http(kHttpPort);
WebSocketsServer ws(kWsPort);
Preferences prefs;
QueueHandle_t lineQueue = nullptr;

String apSsid;
String apPassword;
bool sdReady = false;
String siteVersion = "none";

volatile bool qz1Connected = false;
volatile bool restartBluetoothLink = false;
volatile uint32_t btAttempts = 0;
volatile uint32_t linesTotal = 0;

bool lastBroadcastQz1 = false;
// ONE route at a time: Classic Bluetooth + Bluetooth LE + Wi-Fi + HTTP together left ~21 KB of
// free memory, too little to serve the app (a load failed). Hold button B for 2 s to switch:
// Wi-Fi mode (access point, web page, WebSocket) or Bluetooth mode (BLE for a Web Bluetooth browser).
bool wifiMode = true;
uint8_t page = 0;  // 0 status, 1 Wi-Fi QR, 2 address QR (Wi-Fi mode only)
bool screenOn = true;
uint32_t lastDrawMs = 0;
uint32_t rateWindowStartMs = 0;
uint32_t rateWindowStartLines = 0;
float linesPerSecond = 0.0f;
char lastGga[120] = "";

String statusJson() {
  String s = F("{\"type\":\"status\",\"state\":\"");
  s += qz1Connected ? F("connected") : F("disconnected");
  s += F("\",\"deviceName\":\"");
  s += QZ1_NAME;
  s += F("\"}");
  return s;
}

String randomPassword() {
  static const char alphabet[] = "abcdefghjkmnpqrstuvwxyz23456789";  // no look-alike characters
  String password;
  for (int i = 0; i < 10; i++) {
    password += alphabet[esp_random() % (sizeof(alphabet) - 1)];
  }
  return password;
}

// ---- Bluetooth (own task: connect() can block for many seconds) -------------

bool connectQz1() {
#ifdef QZ1_ADDRESS
  uint8_t address[6] = QZ1_ADDRESS;
  return serialBt.connect(address);
#else
  return serialBt.connect(String(QZ1_NAME));
#endif
}

// A Bluetooth inquiry: lists what is discoverable nearby, so a connect that never
// gets an answer can be told apart from a QZ1 that is simply not visible.
void scanForQz1() {
  LOGLN("[bt] scanning for nearby Bluetooth devices (8 s)...");
  BTScanResults* results = serialBt.discover(8000);
  if (results == nullptr) {
    LOGLN("[bt] scan failed");
    return;
  }
  LOGF("[bt] scan found %d device(s)\n", results->getCount());
  bool sawQz1 = false;
  for (int i = 0; i < results->getCount(); i++) {
    BTAdvertisedDevice* device = results->getDevice(i);
    String name = device->haveName() ? String(device->getName().c_str()) : String("?");
    String address = String(device->getAddress().toString().c_str());
    const bool isQz1 = name.indexOf("QZ1") >= 0;
    sawQz1 = sawQz1 || isQz1;
    LOGF("[bt] scan: %s %s rssi=%d%s\n", name.c_str(), address.c_str(), device->haveRSSI() ? device->getRSSI() : 0,
                  isQz1 ? "  <-- QZ1" : "");
  }
  LOGLN(sawQz1 ? "[bt] the QZ1 IS visible to an inquiry" : "[bt] the QZ1 is NOT visible to an inquiry");
}

void enqueueLine(const char* line, size_t length) {
  if (length == 0 || line[0] != '$') {
    return;  // only NMEA-shaped sentences are passed on
  }
  Line item;
  memcpy(item.text, line, length);
  item.text[length] = '\0';
  xQueueSend(lineQueue, &item, 0);  // full queue: drop, the next fix is a moment away
}

void bluetoothTask(void*) {
  char lineBuffer[kMaxLine + 1];
  size_t lineLength = 0;
  bool overflow = false;
  for (;;) {
    if (restartBluetoothLink) {
      restartBluetoothLink = false;
      LOGLN("[bt] reconnect requested (button B)");
      if (serialBt.connected(0)) {
        serialBt.disconnect();
      }
    }
    if (!serialBt.connected(0)) {
      if (qz1Connected) {
        LOGLN("[bt] QZ1 link lost");
      }
      qz1Connected = false;
      lineLength = 0;
      overflow = false;
      btAttempts = btAttempts + 1;
      if (btAttempts == 2 || btAttempts % 30 == 0) {
        scanForQz1();
      }
      LOGF("[bt] connecting to the QZ1 (attempt %u)\n", static_cast<unsigned>(btAttempts));
      if (connectQz1()) {
        qz1Connected = true;
        LOGLN("[bt] QZ1 connected");
      } else {
        LOGLN("[bt] connect failed (QZ1 on? free? right address / PIN?)");
        vTaskDelay(pdMS_TO_TICKS(2500));
      }
      continue;
    }
    qz1Connected = true;
    while (serialBt.available()) {
      const int c = serialBt.read();
      if (c < 0) {
        break;
      }
      if (c == '\n' || c == '\r') {
        if (!overflow) {
          enqueueLine(lineBuffer, lineLength);
        }
        lineLength = 0;
        overflow = false;
      } else if (lineLength < kMaxLine) {
        lineBuffer[lineLength++] = static_cast<char>(c);
      } else {
        overflow = true;  // too long to be NMEA: drop the whole line
      }
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// ---- WebSocket ---------------------------------------------------------------

void onWsEvent(uint8_t clientNumber, WStype_t type, uint8_t*, size_t) {
  if (type == WStype_CONNECTED) {
    LOGF("[ws] phone %u connected\n", clientNumber);
    String status = statusJson();  // the library takes a non-const reference
    ws.sendTXT(clientNumber, status);
  } else if (type == WStype_DISCONNECTED) {
    LOGF("[ws] phone %u disconnected\n", clientNumber);
  }
}

// ---- Bluetooth LE: the same lines for a browser with Web Bluetooth ------------------
// Nordic UART service UUIDs (a common convention; web/transports.js has
// the same two). The Core2 only notifies; a phone writes nothing.

constexpr const char* kBleService = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* kBleNotify = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

BLECharacteristic* bleNotify = nullptr;
volatile int bleClients = 0;
volatile uint16_t bleMtu = 23;  // until the phone negotiates more

class BleServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    bleClients = bleClients + 1;
    LOGLN("[ble] phone connected");
  }
  void onDisconnect(BLEServer*) override {
    bleClients = bleClients > 0 ? bleClients - 1 : 0;
    bleMtu = 23;
    LOGLN("[ble] phone disconnected");
    BLEDevice::startAdvertising();
  }
  void onMtuChanged(BLEServer*, esp_ble_gatts_cb_param_t* param) override {
    bleMtu = param->mtu.mtu;
    LOGF("[ble] MTU %u\n", static_cast<unsigned>(bleMtu));
  }
};

void startBle() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(185);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new BleServerEvents());
  BLEService* service = server->createService(kBleService);
  bleNotify = service->createCharacteristic(kBleNotify, BLECharacteristic::PROPERTY_NOTIFY);
  bleNotify->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kBleService);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  LOGF("[ble] advertising as %s\n", DEVICE_NAME);
}

// One NMEA line as one or more notifications (a notification carries at most MTU-3 bytes).
void bleSendLine(const char* text) {
  if (bleClients <= 0 || bleNotify == nullptr) return;
  char frame[kMaxLine + 4];
  const int length = snprintf(frame, sizeof(frame), "%s\r\n", text);
  const int chunk = max(20, static_cast<int>(bleMtu) - 3);
  for (int offset = 0; offset < length; offset += chunk) {
    bleNotify->setValue(reinterpret_cast<uint8_t*>(frame) + offset, min(chunk, length - offset));
    bleNotify->notify();
    delay(4);  // let the controller drain; a phone cannot take them back to back
  }
}

// ---- HTTP: the app from the SD card ------------------------------------------

const char kNoSdPage[] PROGMEM =
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>QZ1 iPhone bridge</title><body style='font-family:sans-serif;padding:1rem'>"
    "<h1>QZ1 iPhone bridge</h1><p>The bridge is running, but the SD card has no /www folder.</p>"
    "<p>On the computer run <code>node tools/pack-sd.mjs</code>, then copy <code>dist/www</code> to the card as "
    "<code>/www</code> (or send it over the USB cable with <code>python tools/upload-sd.py</code>), and restart.</p>"
    "<p><a href='/status'>/status</a> &middot; <a href='/ping'>/ping</a></p>";

String contentTypeFor(const String& path) {
  if (path.endsWith(".html")) return F("text/html; charset=utf-8");
  if (path.endsWith(".js") || path.endsWith(".mjs")) return F("text/javascript; charset=utf-8");
  if (path.endsWith(".css")) return F("text/css; charset=utf-8");
  if (path.endsWith(".json")) return F("application/json; charset=utf-8");
  if (path.endsWith(".png")) return F("image/png");
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return F("image/jpeg");
  if (path.endsWith(".svg")) return F("image/svg+xml");
  if (path.endsWith(".ico")) return F("image/x-icon");
  if (path.endsWith(".txt")) return F("text/plain; charset=utf-8");
  return F("application/octet-stream");
}

void handleFile() {
  String path = http.uri();
  LOGF("[http] GET %s (heap %uKB)\n", path.c_str(), static_cast<unsigned>(ESP.getFreeHeap() / 1024));
  if (path.indexOf("..") >= 0) {
    http.send(400, "text/plain", "bad path");
    return;
  }
  if (path.endsWith("/")) {
    path += "index.html";
  }
  if (!sdReady) {
    http.send_P(200, "text/html; charset=utf-8", kNoSdPage);
    return;
  }
  const String full = "/www" + path;
  bool gzipped = false;
  File file = SD.open(full + ".gz");
  if (file && !file.isDirectory()) {
    gzipped = true;
  } else {
    if (file) file.close();
    file = SD.open(full);
  }
  if (!file || file.isDirectory()) {
    if (file) file.close();
    LOGF("[http] 404 %s\n", path.c_str());
    http.send(404, "text/plain", "not found");
    return;
  }
  // The page revalidates every time; an unchanged file costs one tiny 304.
  String build = String(__DATE__) + "_" + String(__TIME__);
  build.replace(" ", "_");
  const String etag = "\"" + siteVersion + "|" + build + "\"";
  http.sendHeader("Cache-Control", "no-cache");
  http.sendHeader("ETag", etag);
  if (http.header("If-None-Match") == etag) {
    file.close();
    http.send(304);
    return;
  }
  // streamFile() adds "Content-Encoding: gzip" by itself for a file named *.gz. Adding it here
  // as well sent the header twice, and Safari then showed the compressed bytes as text.
  http.streamFile(file, contentTypeFor(path));
  file.close();
  LOGF("[http] 200 %s%s\n", path.c_str(), gzipped ? " (gz)" : "");
}

void handleDeviceConfig() {
  http.sendHeader("Cache-Control", "no-store");
  http.send(200, "text/javascript; charset=utf-8",
            "window.SUISUI_LOCAL_DEVICE_WS = \"ws://\" + location.hostname + \":81/\";\n");
}

void handleStatus() {
  String body = F("{\"qz1\":");
  body += qz1Connected ? F("true") : F("false");
  body += F(",\"lines\":");
  body += linesTotal;
  body += F(",\"phones\":");
  body += ws.connectedClients();
  body += F(",\"freeHeap\":");
  body += ESP.getFreeHeap();
  body += F(",\"site\":\"");
  body += siteVersion;
  body += F("\"}");
  http.sendHeader("Cache-Control", "no-store");
  http.send(200, "application/json", body);
}

void loadSiteVersion() {
  siteVersion = "none";
  if (!sdReady) return;
  File file = SD.open("/www/version.txt");
  if (file) {
    siteVersion = file.readStringUntil('\n');
    siteVersion.trim();
    file.close();
    if (siteVersion.length() == 0) siteVersion = "unversioned";
  }
}


// ---- File transfer over USB serial (tools/upload-sd.py) ----------------------
//
// Lets the app be copied to the SD card with the Core2 plugged into a computer, no
// card reader. Lines starting with '@' are commands; everything else is ignored.
//   @BAUD n                 switch the serial speed (replies @OK at the OLD speed first)
//   @WIPE /www              delete a folder (only under /www)
//   @PUT size crc32 path    then `size` raw bytes in chunks of up to 1024; the Core2
//                           answers @A after each chunk, then @DONE or @ERR text
//   @END                    reload the site version, leave transfer mode
// The AP password protects the Wi-Fi; this path needs the cable.

uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t length) {
  crc = ~crc;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));  // zlib-compatible
    }
  }
  return ~crc;
}

bool transferPathOk(const String& path) {
  return path.startsWith("/www") && path.indexOf("..") < 0 && path.length() < 200;
}

void makeParents(const String& path) {
  for (int i = 1; i < static_cast<int>(path.length()); i++) {
    if (path[i] == '/') {
      const String directory = path.substring(0, i);
      if (!SD.exists(directory)) {
        SD.mkdir(directory);
      }
    }
  }
}

void removeRecursive(const String& path) {
  File entry = SD.open(path);
  if (!entry) return;
  if (!entry.isDirectory()) {
    entry.close();
    SD.remove(path);
    return;
  }
  for (File child = entry.openNextFile(); child; child = entry.openNextFile()) {
    String childPath = path + "/" + String(child.name());
    const bool isDirectory = child.isDirectory();
    child.close();
    if (isDirectory) removeRecursive(childPath);
    else SD.remove(childPath);
  }
  entry.close();
  SD.rmdir(path);
}

void reply(const String& text) {
  Serial.print('@');
  Serial.println(text);
  Serial.flush();
}

void transferPut(size_t size, uint32_t expectedCrc, const String& path) {
  if (!sdReady) { reply("ERR no SD card"); return; }
  if (!transferPathOk(path)) { reply("ERR bad path"); return; }
  makeParents(path);
  SD.remove(path);
  File file = SD.open(path, FILE_WRITE);
  if (!file) { reply("ERR cannot open " + path); return; }
  reply("READY");
  uint8_t chunk[1024];
  uint32_t crc = 0;
  size_t received = 0;
  while (received < size) {
    const size_t want = min(sizeof(chunk), size - received);
    const size_t got = Serial.readBytes(chunk, want);  // setTimeout() bounds the wait
    if (got != want) {
      file.close();
      SD.remove(path);
      reply("ERR timeout after " + String(received) + " bytes");
      return;
    }
    if (file.write(chunk, got) != got) {
      file.close();
      SD.remove(path);
      reply("ERR SD write failed (card full?)");
      return;
    }
    crc = crc32Update(crc, chunk, got);
    received += got;
    reply("A");
  }
  file.close();
  if (crc != expectedCrc) {
    SD.remove(path);
    reply("ERR crc " + String(crc, HEX));
    return;
  }
  reply("DONE " + String(received));
}

void handleSerialCommand(const String& line) {
  if (!line.startsWith("@")) return;
  serialQuiet = true;
  if (line.startsWith("@BAUD ")) {
    const long baud = line.substring(6).toInt();
    reply("OK");
    Serial.updateBaudRate(baud);
  } else if (line.startsWith("@WIPE ")) {
    const String path = line.substring(6);
    if (!transferPathOk(path)) { reply("ERR bad path"); return; }
    removeRecursive(path);
    reply("OK");
  } else if (line.startsWith("@PUT ")) {
    const int firstSpace = line.indexOf(' ', 5);
    const int secondSpace = line.indexOf(' ', firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) { reply("ERR syntax"); return; }
    const size_t size = line.substring(5, firstSpace).toInt();
    const uint32_t expectedCrc = strtoul(line.substring(firstSpace + 1, secondSpace).c_str(), nullptr, 16);
    transferPut(size, expectedCrc, line.substring(secondSpace + 1));
  } else if (line.startsWith("@END")) {
    loadSiteVersion();
    reply("OK site " + siteVersion);
    serialQuiet = false;
  } else {
    reply("ERR unknown command");
  }
}

void pollSerialCommands() {
  static String line;
  static uint32_t lastCommandMs = 0;
  if (serialQuiet && millis() - lastCommandMs > 20000) {
    serialQuiet = false;  // the computer went away mid-transfer: log again
  }
  while (Serial.available()) {
    lastCommandMs = millis();
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      handleSerialCommand(line);
      line = "";
    } else if (c != '\r' && line.length() < 300) {
      line += c;
    }
  }
}

// ---- Screen -------------------------------------------------------------------

// nth comma-separated field of an NMEA sentence ("$GNGGA,time,lat,..."): index 0 is the sentence name.
String nmeaField(const char* sentence, int index) {
  int field = 0;
  String out;
  for (const char* p = sentence; *p && *p != '*'; p++) {
    if (*p == ',') {
      if (++field > index) break;
    } else if (field == index) {
      out += *p;
    }
  }
  return out;
}

void drawStatus() {
  auto& d = M5.Display;
  d.fillScreen(TFT_BLACK);
  d.setTextColor(TFT_WHITE, TFT_BLACK);
  d.setTextSize(2);
  d.setCursor(6, 6);
  d.print("QZ1 iPhone bridge");

  d.setCursor(6, 36);
  d.setTextColor(qz1Connected ? TFT_GREEN : TFT_YELLOW, TFT_BLACK);
  if (qz1Connected) {
    d.print("QZ1: connected");
  } else {
    d.printf("QZ1: searching (%u)", static_cast<unsigned>(btAttempts));
  }

  d.setTextColor(TFT_WHITE, TFT_BLACK);
  d.setCursor(6, 62);
  d.printf("Phones: %d", wifiMode ? static_cast<int>(ws.connectedClients()) : static_cast<int>(bleClients));
  d.setCursor(6, 86);
  d.printf("Lines/s: %.1f", linesPerSecond);

  d.setCursor(6, 114);
  if (lastGga[0]) {
    const String quality = nmeaField(lastGga, 6);
    const String sats = nmeaField(lastGga, 7);
    const String hdop = nmeaField(lastGga, 8);
    d.printf("Fix %s  sat %s  hdop %s", quality.c_str(), sats.c_str(), hdop.c_str());
  } else {
    d.print("Fix: no GGA yet");
  }

  d.setTextSize(1);
  d.setCursor(6, 150);
  if (wifiMode) {
    d.printf("Wi-Fi: %s", apSsid.c_str());
    d.setCursor(6, 164);
    d.print("Open  http://192.168.4.1/");
  } else {
    d.printf("Bluetooth LE: %s", DEVICE_NAME);
    d.setCursor(6, 164);
    d.print("Pick it in the web page (Bluefy / Chrome)");
  }
  d.setCursor(6, 178);
  d.printf("SD: %s   site: %s", sdReady ? "ok" : "MISSING", siteVersion.c_str());
  d.setCursor(6, 192);
  d.printf("Free heap: %u KB", static_cast<unsigned>(ESP.getFreeHeap() / 1024));
  d.setCursor(6, 206);
  d.printf("Mode: %s   (hold B 2 s to switch)", wifiMode ? "Wi-Fi" : "Bluetooth");

  d.setTextColor(TFT_CYAN, TFT_BLACK);
  d.setCursor(6, 224);
  d.print("A: page   B: QZ1 reconnect   hold B: mode   C: screen");
}

void drawQr(const char* title, const String& payload, const String& caption) {
  auto& d = M5.Display;
  d.fillScreen(TFT_WHITE);
  d.setTextColor(TFT_BLACK, TFT_WHITE);
  d.setTextSize(2);
  d.setCursor(6, 4);
  d.print(title);
  d.qrcode(payload.c_str(), 60, 28, 190, 6);
  d.setTextSize(1);
  d.setCursor(6, 224);
  d.print(caption);
}

void drawScreen() {
  if (!screenOn) return;
  if (page == 1) {
    drawQr("1. Join this Wi-Fi", "WIFI:T:WPA;S:" + apSsid + ";P:" + apPassword + ";;",
           apSsid + "  password: " + apPassword);
  } else if (page == 2) {
    drawQr("2. Open the page", "http://192.168.4.1/", "http://192.168.4.1/   (A: next)");
  } else {
    drawStatus();
  }
}

void setScreen(bool on) {
  screenOn = on;
  if (on) {
    M5.Display.wakeup();
    M5.Display.setBrightness(128);
    drawScreen();
  } else {
    M5.Display.setBrightness(0);
    M5.Display.sleep();
  }
}

}  // namespace

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  Serial.setTimeout(5000);
  LOGLN("\nQZ1 iPhone bridge starting");
  auto cfg = M5.config();
  M5.begin(cfg);
  M5.Display.setBrightness(128);
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 6);
  M5.Display.print("Starting...");

  // A random Wi-Fi password, made once and kept (nothing secret lives in the source).
  prefs.begin("core2", false);
  wifiMode = prefs.getUChar("ble", 0) == 0;
  apPassword = prefs.getString("appw", "");
  if (apPassword.length() < 8) {
    apPassword = randomPassword();
    prefs.putString("appw", apPassword);
  }
  prefs.end();

  if (wifiMode) {
  WiFi.mode(WIFI_AP);
  uint8_t mac[6];
  WiFi.softAPmacAddress(mac);
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "%02X%02X", mac[4], mac[5]);
  apSsid = String(AP_SSID_PREFIX) + "-" + suffix;
  WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
  WiFi.softAP(apSsid.c_str(), apPassword.c_str(), 6, 0, 4);
  WiFi.setSleep(false);
  LOGF("[wifi] access point \"%s\" at %s\n", apSsid.c_str(), WiFi.softAPIP().toString().c_str());
  } else {
    WiFi.mode(WIFI_OFF);
    LOGLN("[mode] Bluetooth mode: Wi-Fi is off");
  }

  SPI.begin(18, 38, 23, kSdChipSelect);
  sdReady = SD.begin(kSdChipSelect, SPI, 25000000);
  loadSiteVersion();
  LOGF("[sd] %s, site version \"%s\"\n", sdReady ? "mounted" : "NOT mounted", siteVersion.c_str());

  if (wifiMode) {
  const char* headerKeys[] = {"If-None-Match"};
  http.collectHeaders(headerKeys, 1);
  http.on("/config/local-device.js", handleDeviceConfig);
  http.on("/status", handleStatus);
  http.on("/ping", []() { http.sendHeader("Cache-Control", "no-store"); http.send(200, "text/plain", "ok"); });
  http.onNotFound(handleFile);
  http.begin();

  ws.begin();
  ws.onEvent(onWsEvent);
  ws.enableHeartbeat(15000, 3000, 2);
  }

  lineQueue = xQueueCreate(12, sizeof(Line));  // ~1.6 KB (64 slots of 258 bytes took ~16 KB)

#if QZ1_USE_SSP
  // Secure Simple Pairing: accept the "is this number the same?" prompt by itself.
  serialBt.onConfirmRequest([](uint32_t number) {
    LOGF("[bt] pairing confirm request (%06u): accepting\n", static_cast<unsigned>(number));
    serialBt.confirmReply(true);
  });
  serialBt.onAuthComplete([](bool success) {
    LOGF("[bt] pairing %s\n", success ? "succeeded" : "FAILED");
  });
  serialBt.enableSSP();
#else
  serialBt.setPin(QZ1_PIN);
#endif
  serialBt.begin(DEVICE_NAME, true);  // master: the Core2 connects to the QZ1
  if (!wifiMode) {
    startBle();                          // peripheral: a Web Bluetooth browser connects to the Core2
  }
  M5.BtnB.setHoldThresh(2000);
  xTaskCreatePinnedToCore(bluetoothTask, "qz1-bt", 6144, nullptr, 1, nullptr, 0);

  rateWindowStartMs = millis();
  page = 0;  // the live status page; in Wi-Fi mode A cycles to the Wi-Fi / address QR codes
  LOGF("[mode] %s mode\n", wifiMode ? "Wi-Fi" : "Bluetooth");
  drawScreen();
}

void loop() {
  M5.update();
  pollSerialCommands();
  if (wifiMode) {
    http.handleClient();
    ws.loop();
  }

  // Pass completed lines from the Bluetooth task on to every phone.
  Line item;
  int sent = 0;
  while (sent < 40 && xQueueReceive(lineQueue, &item, 0) == pdTRUE) {
    char frame[kMaxLine + 8];
    snprintf(frame, sizeof(frame), "%s\r\n", item.text);
    if (wifiMode) {
      ws.broadcastTXT(frame);
    } else {
      bleSendLine(item.text);
    }
    linesTotal = linesTotal + 1;
    sent++;
    if (strncmp(item.text + 3, "GGA", 3) == 0) {
      strlcpy(lastGga, item.text, sizeof(lastGga));
    }
  }

  // Tell the phones when the QZ1 link comes or goes.
  if (qz1Connected != lastBroadcastQz1) {
    lastBroadcastQz1 = qz1Connected;
    if (wifiMode) {
      String status = statusJson();
      ws.broadcastTXT(status);
    }
  }

  const uint32_t now = millis();
  static uint32_t lastStatsMs = 0;
  if (now - lastStatsMs >= 10000) {
    lastStatsMs = now;
    LOGF("[stats] mode=%s qz1=%s ap-stations=%u ws=%u ble=%d lines=%u heap=%uKB (largest block %uKB)\n", wifiMode ? "wifi" : "ble",
                  qz1Connected ? "yes" : "no", static_cast<unsigned>(wifiMode ? WiFi.softAPgetStationNum() : 0),
                  static_cast<unsigned>(wifiMode ? ws.connectedClients() : 0), static_cast<int>(bleClients),
                  static_cast<unsigned>(linesTotal), static_cast<unsigned>(ESP.getFreeHeap() / 1024),
                  static_cast<unsigned>(ESP.getMaxAllocHeap() / 1024));
  }
  if (now - rateWindowStartMs >= kRateWindowMs) {
    linesPerSecond = (linesTotal - rateWindowStartLines) * 1000.0f / (now - rateWindowStartMs);
    rateWindowStartMs = now;
    rateWindowStartLines = linesTotal;
  }

  if (M5.BtnA.wasPressed()) {
    page = (page + 1) % (wifiMode ? 3 : 1);
    if (!screenOn) setScreen(true);
    drawScreen();
  }
  if (M5.BtnB.wasHold()) {
    prefs.begin("core2", false);
    prefs.putUChar("ble", wifiMode ? 1 : 0);  // the other mode after the restart
    prefs.end();
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setTextSize(2);
    M5.Display.setCursor(6, 100);
    M5.Display.print(wifiMode ? "-> Bluetooth mode" : "-> Wi-Fi mode");
    delay(700);
    ESP.restart();
  }
  if (M5.BtnB.wasClicked()) {
    restartBluetoothLink = true;
  }
  if (M5.BtnC.wasPressed()) {
    setScreen(!screenOn);
  }

  if (screenOn && page == 0 && now - lastDrawMs >= 500) {
    lastDrawMs = now;
    drawScreen();
  }
}
