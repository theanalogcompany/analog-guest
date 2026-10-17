// Analog receipt printer bridge for the Seeed XIAO ESP32-C3.
//
// Polls GET /api/devices/{id}/print-jobs, and for each job prints the finished
// scan URL as a QR on a LAN ESC/POS printer (TCP 9100). The URL is printed
// verbatim: the server owns the link format (lib/pos/scan-link.ts).
//
// FAILURE DIRECTION: closed per job. The cursor advances only after the whole
// payload has been written to the printer, so an unreachable printer or a
// failed poll re-delivers the job on the next poll instead of dropping a slip.
// A power cut mid-write can duplicate a slip; it cannot lose one.
#include <Arduino.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include <vector>

#include "config.h"
#include "certs.h"
#include "escpos.h"

static Preferences prefs;
static String cursor;

static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("wifi: connecting");
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print('.');
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " failed");
}

// TLS needs a sane clock to check certificate validity.
static bool syncClock() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 20; i++) {
    if (time(nullptr) > 1700000000) return true;
    delay(500);
  }
  return false;
}

static bool printToPrinter(const std::vector<uint8_t> &payload) {
  WiFiClient client;
  client.setTimeout(5);
  if (!client.connect(PRINTER_IP, PRINTER_PORT, 5000)) {
    Serial.println("printer: connect failed");
    return false;
  }
  size_t written = client.write(payload.data(), payload.size());
  client.flush();
  delay(300);  // let the printer drain before the socket closes
  client.stop();
  bool ok = written == payload.size();
  if (!ok) Serial.println("printer: short write");
  return ok;
}

static void pollOnce() {
  WiFiClientSecure tls;
  tls.setCACert(ROOT_CA_PEM);
  tls.setTimeout(10);

  String url = String("https://") + API_HOST + "/api/devices/" + DEVICE_ID + "/print-jobs";
  if (cursor.length() > 0) {
    // The feed's timestamps end in "+00:00"; a raw "+" in a query string reads
    // back as a space and the server rejects the cursor with a 500.
    String since = cursor;
    since.replace("+", "%2B");
    url += "?since=" + since;
  }

  HTTPClient http;
  if (!http.begin(tls, url)) {
    Serial.println("http: begin failed");
    return;
  }
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("http: status %d\n", code);
    http.end();
    return;
  }
  String body = http.getString();
  http.end();

  // Minimal parse of {"cursor":..,"jobs":[{"id","at","url"}]} without a JSON
  // dependency: pull each job's "at" and "url" in order.
  int pos = body.indexOf("\"jobs\"");
  while (pos >= 0) {
    int atKey = body.indexOf("\"at\":\"", pos);
    int urlKey = body.indexOf("\"url\":\"", pos);
    if (atKey < 0 || urlKey < 0) break;
    int atStart = atKey + 6;
    int urlStart = urlKey + 7;
    String at = body.substring(atStart, body.indexOf('"', atStart));
    String link = body.substring(urlStart, body.indexOf('"', urlStart));
    link.replace("\\u0026", "&");
    link.replace("\\/", "/");

    Serial.printf("job at %s -> %s\n", at.c_str(), link.c_str());
    if (!printToPrinter(buildQrSlip(link.c_str(), QR_MODULE_SIZE))) return;  // retry next poll
    cursor = at;
    prefs.putString("cursor", cursor);
    pos = max(atStart, urlStart);
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  prefs.begin("printer", false);
  cursor = prefs.getString("cursor", "");
  Serial.printf("cursor: %s\n", cursor.length() ? cursor.c_str() : "(none)");
  connectWifi();
  if (!syncClock()) Serial.println("clock: ntp sync failed, TLS will fail");
  // First boot: start from now, never reprint the venue's history.
  if (cursor.length() == 0 && time(nullptr) > 1700000000) {
    char buf[32];
    time_t t = time(nullptr);
    strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", gmtime(&t));
    cursor = buf;
    prefs.putString("cursor", cursor);
    Serial.printf("cursor: initialised to %s\n", buf);
  }
}

void loop() {
  connectWifi();
  if (WiFi.status() == WL_CONNECTED && cursor.length() > 0) pollOnce();
  delay(POLL_INTERVAL_MS);
}
