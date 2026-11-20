#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "DHT.h"

#include "config.h"

// =========================
// MQTT CONFIGURATION
// =========================

const char* MQTT_SERVER = "broker.emqx.io";
const int MQTT_PORT = 1883;

// Phai giong topic dang subscribe o backend
const char* MQTT_TOPIC = "iot/esp32/weather/giang0811/data";
const char* MQTT_CONTROL_TOPIC = "iot/esp32/weather/giang0811/control";

// =========================
// PIN CONFIGURATION
// =========================

// DHT11
#define DHT_PIN 27
#define DHT_TYPE DHT11

// LDR
#define LDR_PIN 34

// 3 LED
#define LED_RED    25
#define LED_GREEN  26
#define LED_YELLOW 32

// Buzzer
#define BUZZER_PIN 23

// OLED
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define OLED_SDA 21
#define OLED_SCL 22
#define OLED_ADDR 0x3C

// =========================
// OBJECTS & STATE
// =========================

DHT dht(DHT_PIN, DHT_TYPE);

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  -1
);

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

bool oledReady = false;
String serialBuffer = "";
bool buzzerMuted = false;
bool isDangerActive = false;
bool hasLastReading = false;
float lastTemp = 0.0;
float lastHum = 0.0;
bool lastIsDark = false;
String lastStatus = "NORMAL";

// =========================
// THRESHOLDS
// =========================

const float TEMP_WARNING = 33.0;
const float TEMP_DANGER  = 37.0;

const float HUM_WARNING = 76.0;
const float HUM_DANGER  = 85.0;

// =========================
// TIMERS
// =========================

unsigned long lastSensorTick = 0;
unsigned long lastPublish = 0;
unsigned long lastMqttRetry = 0;
bool mqttRetryArmed = false;
const unsigned long SENSOR_INTERVAL = 2000;
const unsigned long PUBLISH_INTERVAL = 2000;
const unsigned long MQTT_RETRY_INTERVAL = 8000;

// =========================
// LED & BUZZER CONTROL
// =========================

void allLEDOff() {
  digitalWrite(LED_RED, LOW);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_YELLOW, LOW);
}

void ledGreen() {
  allLEDOff();
  digitalWrite(LED_GREEN, HIGH);
}

void ledYellow() {
  allLEDOff();
  digitalWrite(LED_YELLOW, HIGH);
}

void ledRed() {
  allLEDOff();
  digitalWrite(LED_RED, HIGH);
}

void buzzerOn() {
  tone(BUZZER_PIN, 2000);
}

void buzzerOff() {
  noTone(BUZZER_PIN);
}

// =========================
// OLED HELPERS
// =========================

void showOLEDMessage(const char* line1, const char* line2 = "", const char* line3 = "") {
  if (!oledReady) {
    return;
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 8);
  display.println(line1);

  if (line2[0] != '\0') {
    display.setCursor(0, 26);
    display.println(line2);
  }

  if (line3[0] != '\0') {
    display.setCursor(0, 44);
    display.println(line3);
  }

  display.display();
}

void showOLED(
  float temperature,
  float humidity,
  bool isDark,
  String status
) {
  if (!oledReady) {
    return;
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);
  display.print("Temp: ");
  display.print(temperature, 1);
  display.println(" C");

  display.setCursor(0, 15);
  display.print("Hum : ");
  display.print(humidity, 1);
  display.println(" %");

  display.setCursor(0, 30);
  display.print("Light: ");
  display.println(isDark ? "DARK" : "BRIGHT");

  display.setCursor(0, 45);
  display.print("Status: ");
  display.println(status);

  display.display();
}

// =========================
// JSON ESCAPE HELPER
// =========================

String escapeJson(const String& input) {
  String out = "";
  out.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); i++) {
    char c = input.charAt(i);
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c == '\b') out += "\\b";
    else if (c == '\f') out += "\\f";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if ((uint8_t)c >= 0x20) out += c;
  }
  return out;
}

// =========================
// USB SERIAL WIFI PROVISIONING (RAM ONLY)
// =========================

void handleScanCommand() {
  WiFi.mode(WIFI_STA);
  int count = WiFi.scanNetworks(false, false);

  if (count < 0) {
    Serial.println("@@SCAN_RESULT:{\"ok\":false,\"error\":\"WiFi scan failed\",\"networks\":[]}");
    return;
  }

  // Deduplicate SSIDs (keep strongest signal for each SSID)
  const int MAX_UNIQUE = 25;
  String ssids[MAX_UNIQUE];
  int rssis[MAX_UNIQUE];
  bool secured[MAX_UNIQUE];
  int uniqueCount = 0;

  for (int i = 0; i < count; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0) {
      continue;
    }

    int r = WiFi.RSSI(i);
    bool sec = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);

    int existing = -1;
    for (int j = 0; j < uniqueCount; j++) {
      if (ssids[j] == s) {
        existing = j;
        break;
      }
    }

    if (existing >= 0) {
      if (r > rssis[existing]) {
        rssis[existing] = r;
        secured[existing] = sec;
      }
    } else if (uniqueCount < MAX_UNIQUE) {
      ssids[uniqueCount] = s;
      rssis[uniqueCount] = r;
      secured[uniqueCount] = sec;
      uniqueCount++;
    }
  }

  // Sort descending by RSSI
  for (int i = 0; i < uniqueCount - 1; i++) {
    for (int j = i + 1; j < uniqueCount; j++) {
      if (rssis[j] > rssis[i]) {
        String tmpS = ssids[i]; ssids[i] = ssids[j]; ssids[j] = tmpS;
        int tmpR = rssis[i]; rssis[i] = rssis[j]; rssis[j] = tmpR;
        bool tmpSec = secured[i]; secured[i] = secured[j]; secured[j] = tmpSec;
      }
    }
  }

  WiFi.scanDelete();

  String json = "@@SCAN_RESULT:{\"ok\":true,\"networks\":[";
  for (int i = 0; i < uniqueCount; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + escapeJson(ssids[i]) + "\",";
    json += "\"rssi\":" + String(rssis[i]) + ",";
    json += "\"secured\":" + String(secured[i] ? "true" : "false") + "}";
  }
  json += "]}";
  Serial.println(json);
}

void handleStatusCommand() {
  bool connected = (WiFi.status() == WL_CONNECTED);
  String ssid = connected ? WiFi.SSID() : "";
  String ip = connected ? WiFi.localIP().toString() : "";
  int rssi = connected ? WiFi.RSSI() : 0;
  bool mqttOk = mqttClient.connected();

  String json = "@@STATUS_RESULT:{";
  json += "\"connected\":" + String(connected ? "true" : "false") + ",";
  json += "\"ssid\":\"" + escapeJson(ssid) + "\",";
  json += "\"ip\":\"" + escapeJson(ip) + "\",";
  json += "\"rssi\":" + String(rssi) + ",";
  json += "\"mqtt\":" + String(mqttOk ? "true" : "false") + "}";
  Serial.println(json);
}

void handleDisconnectCommand() {
  if (mqttClient.connected()) {
    mqttClient.disconnect();
  }
  mqttRetryArmed = false;
  isDangerActive = false;
  buzzerMuted = false;
  WiFi.disconnect(false, true);
  delay(150);
  allLEDOff();
  buzzerOff();
  showOLEDMessage("WAIT WIFI VIA USB", "Mo Web -> Cai dat", "Quet & ket noi WiFi");
  Serial.println("@@DISCONNECT_OK:{\"ok\":true}");
}

void handleConnectCommand(const String& payload) {
  int sep = payload.indexOf('\t');
  if (sep <= 0) {
    Serial.println("@@WIFI_ERR:Invalid command format");
    return;
  }

  String ssid = payload.substring(0, sep);
  String password = payload.substring(sep + 1);

  if (ssid.length() == 0) {
    Serial.println("@@WIFI_ERR:Empty SSID");
    return;
  }

  if (mqttClient.connected()) {
    mqttClient.disconnect();
  }
  mqttRetryArmed = false;

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true);
  delay(150);

  showOLEDMessage("Connecting WiFi...", ssid.c_str(), "Via USB (RAM only)");

  if (password.length() > 0) {
    WiFi.begin(ssid.c_str(), password.c_str());
  } else {
    WiFi.begin(ssid.c_str());
  }

  unsigned long startAttempt = millis();
  const unsigned long CONNECT_TIMEOUT = 15000;

  while (WiFi.status() != WL_CONNECTED && (millis() - startAttempt) < CONNECT_TIMEOUT) {
    wl_status_t st = WiFi.status();
    if (st == WL_CONNECT_FAILED || st == WL_NO_SSID_AVAIL) {
      break;
    }
    delay(100);
  }

  if (WiFi.status() == WL_CONNECTED) {
    String ip = WiFi.localIP().toString();
    showOLEDMessage("WIFI CONNECTED!", ssid.c_str(), ip.c_str());
    Serial.println("@@WIFI_OK:{\"ssid\":\"" + escapeJson(ssid) + "\",\"ip\":\"" + escapeJson(ip) + "\"}");
    delay(250);
  } else {
    WiFi.disconnect(false);
    showOLEDMessage("WIFI FAILED!", "Kiem tra mat khau", "hoac thu lai");
    Serial.println("@@WIFI_ERR:Khong the ket noi WiFi (sai mat khau hoac qua thoi gian)");
    delay(500);
    showOLEDMessage("WAIT WIFI VIA USB", "Mo Web -> Cai dat", "Quet & ket noi WiFi");
  }
}

void processSerialLine(String line) {
  line.trim();
  if (line.length() == 0) {
    return;
  }

  if (line == "@@PING") {
    Serial.println("@@PONG");
  } else if (line == "@@STATUS") {
    handleStatusCommand();
  } else if (line == "@@DISCONNECT") {
    handleDisconnectCommand();
  } else if (line == "@@SCAN") {
    handleScanCommand();
  } else if (line.startsWith("@@CONNECT\t")) {
    handleConnectCommand(line.substring(10));
  }
}

void handleSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      processSerialLine(serialBuffer);
      serialBuffer = "";
    } else if (c != '\r') {
      if (serialBuffer.length() < 256) {
        serialBuffer += c;
      } else {
        serialBuffer = "";
      }
    }
  }
}

// =========================
// MQTT
// =========================

void publishMQTT(
  float temperature,
  float humidity,
  bool isDark,
  String status
) {
  if (!mqttClient.connected()) {
    return;
  }

  char payload[240];

  snprintf(
    payload,
    sizeof(payload),
    "{\"temperature\":%.1f,\"humidity\":%.1f,\"light\":\"%s\",\"status\":\"%s\",\"buzzer_muted\":%s}",
    temperature,
    humidity,
    isDark ? "DARK" : "BRIGHT",
    status.c_str(),
    buzzerMuted ? "true" : "false"
  );

  bool success = mqttClient.publish(MQTT_TOPIC, payload);

  Serial.print("MQTT topic: ");
  Serial.println(MQTT_TOPIC);

  Serial.print("MQTT payload: ");
  Serial.println(payload);

  if (success) {
    Serial.println("MQTT publish success");
  } else {
    Serial.println("MQTT publish failed");
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != MQTT_CONTROL_TOPIC) {
    return;
  }

  String msg = "";
  msg.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  msg.trim();
  msg.toUpperCase();

  if (msg == "MUTE" || msg == "OFF" || msg == "0") {
    buzzerMuted = true;
    buzzerOff();
    Serial.println("[MQTT CTRL] Buzzer muted from Web");
  } else if (msg == "UNMUTE" || msg == "ON" || msg == "1") {
    buzzerMuted = false;
    if (isDangerActive) {
      buzzerOn();
      Serial.println("[MQTT CTRL] Buzzer unmuted from Web");
    } else {
      buzzerOff();
    }
  }

  if (hasLastReading && WiFi.status() == WL_CONNECTED) {
    lastPublish = millis();
    publishMQTT(lastTemp, lastHum, lastIsDark, lastStatus);
  }
}

void tryConnectMQTT() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) {
    return;
  }

  unsigned long now = millis();
  if (mqttRetryArmed && (now - lastMqttRetry < MQTT_RETRY_INTERVAL)) {
    return;
  }
  mqttRetryArmed = true;
  lastMqttRetry = now;

  Serial.print("Connecting to MQTT... ");

  String clientId = "ESP32-Weather-";
  clientId += String(
    (uint32_t)(ESP.getEfuseMac() & 0xFFFFFFFF),
    HEX
  );

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("connected");
    mqttClient.subscribe(MQTT_CONTROL_TOPIC);
  } else {
    Serial.print("failed, state = ");
    Serial.println(mqttClient.state());
  }
}

// =========================
// SETUP
// =========================

void setup() {
  Serial.begin(115200);
  serialBuffer.reserve(256);

  // Bao dam khong luu mat khau WiFi vao Flash/NVS
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);

  // DHT11
  dht.begin();

  // 3 LED
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  allLEDOff();

  // Buzzer
  pinMode(BUZZER_PIN, OUTPUT);
  buzzerOff();

  // LDR
  pinMode(LDR_PIN, INPUT);

  // OLED
  Wire.begin(OLED_SDA, OLED_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    oledReady = true;
    showOLEDMessage("WEATHER STATION", "WAIT WIFI VIA USB", "Mo Web -> Cai dat");
  } else {
    Serial.println("OLED not detected - continuing in USB mode");
  }

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setSocketTimeout(2);
  mqttClient.setBufferSize(256);
}

// =========================
// LOOP
// =========================

void loop() {
  // Luon lang nghe lenh WiFi qua USB bat ke luc nao
  handleSerialCommands();

  if (WiFi.status() != WL_CONNECTED) {
    isDangerActive = false;
    buzzerMuted = false;
    allLEDOff();
    buzzerOff();
    delay(20);
    return;
  }

  tryConnectMQTT();
  mqttClient.loop();

  unsigned long now = millis();
  if (now - lastSensorTick < SENSOR_INTERVAL) {
    delay(10);
    return;
  }
  lastSensorTick = now;

  // READ DHT11
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();

  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("DHT11 ERROR!");
    isDangerActive = false;
    buzzerMuted = false;
    allLEDOff();
    buzzerOff();
    showOLEDMessage("DHT11 ERROR", "Kiem tra cam bien");
    return;
  }

  // READ LDR (HIGH = DARK, LOW = BRIGHT)
  int lightState = digitalRead(LDR_PIN);
  bool isDark = (lightState == HIGH);

  // DETERMINE STATUS
  String status;
  if (temperature >= TEMP_DANGER || humidity >= HUM_DANGER) {
    status = "DANGER";
    isDangerActive = true;
    ledRed();
    if (buzzerMuted) {
      buzzerOff();
    } else {
      buzzerOn();
    }
  } else {
    isDangerActive = false;
    buzzerMuted = false;
    if (temperature >= TEMP_WARNING || humidity >= HUM_WARNING) {
      status = "WARNING";
      ledYellow();
      buzzerOff();
    } else {
      status = "NORMAL";
      ledGreen();
      buzzerOff();
    }
  }

  lastTemp = temperature;
  lastHum = humidity;
  lastIsDark = isDark;
  lastStatus = status;
  hasLastReading = true;

  // OLED
  showOLED(temperature, humidity, isDark, status);

  // SERIAL MONITOR
  Serial.println("============================");
  Serial.print("Temperature: ");
  Serial.print(temperature);
  Serial.println(" C");
  Serial.print("Humidity: ");
  Serial.print(humidity);
  Serial.println(" %");
  Serial.print("Light: ");
  Serial.println(isDark ? "DARK" : "BRIGHT");
  Serial.print("Status: ");
  Serial.println(status);

  // MQTT PUBLISH
  if (now - lastPublish >= PUBLISH_INTERVAL) {
    lastPublish = now;
    publishMQTT(temperature, humidity, isDark, status);
  }
  Serial.println("============================");
}
