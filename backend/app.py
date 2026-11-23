from collections import deque
from datetime import datetime
from threading import Lock, Thread, Timer
import io
import json
import os
import socket
import sqlite3
import sys
import time
import urllib.request
import uuid
import webbrowser

import paho.mqtt.client as mqtt
import qrcode
import qrcode.image.svg
import serial
import serial.tools.list_ports

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.serving import make_server

try:
    import webview
except ImportError:
    webview = None


# ==================================================
# FLASK & FRONTEND / SQLITE PATH CONFIGURATION
# ==================================================

if getattr(sys, "frozen", False):
    BASE_RUNTIME_DIR = os.path.dirname(sys.executable)
    FRONTEND_DIR = os.path.join(sys._MEIPASS, "frontend")
else:
    BASE_RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))
    FRONTEND_DIR = os.path.abspath(os.path.join(BASE_RUNTIME_DIR, "..", "frontend"))

DB_PATH = os.path.join(BASE_RUNTIME_DIR, "weather_station.db")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)


# ==================================================
# SQLITE DATABASE CONFIGURATION
# ==================================================


def get_db_connection():
    """Tạo kết nối đến cơ sở dữ liệu SQLite cục bộ."""
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_sensor_table():
    """Tạo bảng sensor_data và bật chế độ WAL nếu chưa tồn tại."""
    conn = None
    try:
        conn = get_db_connection()
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sensor_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                light TEXT NOT NULL,
                status TEXT NOT NULL,
                received_at TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()
    finally:
        if conn is not None:
            conn.close()


def save_sensor_data(record):
    """Lưu một bản ghi cảm biến vào SQLite."""
    conn = None
    try:
        conn = get_db_connection()
        conn.execute(
            """
            INSERT INTO sensor_data
                (temperature, humidity, light, status, received_at)
            VALUES
                (?, ?, ?, ?, ?)
            """,
            (
                record["temperature"],
                record["humidity"],
                record["light"],
                record["status"],
                record["received_at"],
            ),
        )
        conn.commit()
        print("[SQLite] Sensor data saved successfully")
        return True
    except sqlite3.Error as error:
        print(f"[SQLite] Save failed: {error}")
        return False
    finally:
        if conn is not None:
            conn.close()


# ==================================================
# SAVE INTERVAL & MQTT CONFIGURATION
# ==================================================

DB_SAVE_INTERVAL = 10
last_db_save_time = 0

MQTT_HOST = "broker.emqx.io"
MQTT_PORT = 1883
MQTT_TOPIC = "iot/esp32/weather/giang0811/data"
MQTT_CONTROL_TOPIC = "iot/esp32/weather/giang0811/control"


# ==================================================
# DATA STORAGE
# ==================================================

SENSOR_STALE_TIMEOUT = 8.0

latest_data = None
last_data_monotonic = 0.0
sensor_history = deque(maxlen=100)
data_lock = Lock()
mqtt_connected = False


# ==================================================
# ESP32 USB SERIAL HELPERS (AUTO-DETECT COM PORT)
# ==================================================

serial_lock = Lock()
ESP32_USB_VIDS = {0x10C4, 0x1A86, 0x0403, 0x303A}


def _ranked_usb_ports():
    """Lọc bỏ cổng Bluetooth ảo, ưu tiên chip USB-UART của ESP32."""
    preferred = []
    others = []

    for port in serial.tools.list_ports.comports():
        desc = (port.description or "").lower()
        hwid = (port.hwid or "").lower()

        if "bluetooth" in desc or "bthenum" in hwid:
            continue

        if port.vid in ESP32_USB_VIDS:
            preferred.append(port)
        else:
            others.append(port)

    return preferred + others


def _open_serial_clean(device_name):
    """Mở cổng COM ở 115200 baud và hạn chế auto-reset DTR/RTS."""
    ser = serial.Serial()
    ser.port = device_name
    ser.baudrate = 115200
    ser.timeout = 0.15
    ser.write_timeout = 1.0
    ser.dtr = False
    ser.rts = False
    ser.open()
    return ser


def _ping_esp32(ser):
    """Kiểm tra đúng mạch ESP32 Weather Station bằng @@PING -> @@PONG."""
    ser.reset_input_buffer()
    ser.write(b"@@PING\n")
    ser.flush()

    deadline = time.monotonic() + 3.0
    next_retry = time.monotonic() + 1.0

    while time.monotonic() < deadline:
        raw = ser.readline()
        if raw:
            line = raw.decode("utf-8", errors="ignore").strip()
            if line == "@@PONG":
                return True
        elif time.monotonic() >= next_retry:
            ser.write(b"@@PING\n")
            ser.flush()
            next_retry = time.monotonic() + 1.0

    return False


def _find_and_open_esp32():
    """
    Tự động dò cổng USB của ESP32 và trả về (ser, device_name, error_msg, status_code).
    Người gọi chịu trách nhiệm đóng ser trong khối finally.
    """
    ports = _ranked_usb_ports()
    if not ports:
        return None, None, "Chưa phát hiện mạch ESP32 cắm qua USB.", 404

    busy_ports = []

    for port in ports:
        ser = None
        try:
            ser = _open_serial_clean(port.device)
            if _ping_esp32(ser):
                return ser, port.device, None, 200
            ser.close()
        except serial.SerialException:
            if ser is not None and ser.is_open:
                ser.close()
            busy_ports.append(port.device)

    if busy_ports:
        joined = ", ".join(busy_ports)
        return (
            None,
            None,
            f"Cổng {joined} đang bị chương trình khác chiếm (ví dụ Serial Monitor). Hãy đóng lại rồi thử quét lại.",
            409,
        )

    found = ", ".join(p.device for p in ports)
    return (
        None,
        None,
        f"Tìm thấy cổng {found} nhưng mạch chưa phản hồi. Hãy kiểm tra đã nạp firmware mới chưa.",
        503,
    )


def _read_prefixed_line(ser, prefixes, timeout_sec):
    """Đọc dòng Serial có tiền tố khớp trong khoảng timeout_sec."""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        raw = ser.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", errors="ignore").strip()
        for prefix in prefixes:
            if line.startswith(prefix):
                return prefix, line[len(prefix):]
    return None, None


def _send_esp32_command(command_bytes, prefixes, timeout_sec, timeout_detail):
    """Dò cổng ESP32, gửi một lệnh Serial và chờ dòng phản hồi khớp tiền tố."""
    with serial_lock:
        ser, port_name, err_msg, status_code = _find_and_open_esp32()
        if ser is None:
            return None, None, None, (jsonify({"error": err_msg}), status_code)

        try:
            ser.reset_input_buffer()
            ser.write(command_bytes)
            ser.flush()

            prefix, payload = _read_prefixed_line(ser, prefixes, timeout_sec)
            if prefix is None:
                return None, None, port_name, (
                    jsonify({"error": f"ESP32 ({port_name}) {timeout_detail}"}),
                    504,
                )

            return prefix, payload, port_name, None
        except serial.SerialException as exc:
            return None, None, port_name, (
                jsonify({"error": f"Lỗi giao tiếp USB ({port_name}): {exc}"}),
                500,
            )
        finally:
            if ser.is_open:
                ser.close()


# ==================================================
# MQTT CALLBACKS
# ==================================================

def on_connect(client, userdata, flags, reason_code, properties):
    """Được gọi khi backend kết nối MQTT Broker."""
    global mqtt_connected

    if reason_code.is_failure:
        mqtt_connected = False
        print(f"[MQTT] Connection failed: {reason_code}")
        return

    mqtt_connected = True
    print("[MQTT] Connected to broker")

    result, message_id = client.subscribe(MQTT_TOPIC)

    if result == mqtt.MQTT_ERR_SUCCESS:
        print(f"[MQTT] Subscribed to: {MQTT_TOPIC}")
    else:
        print(f"[MQTT] Subscribe failed: {result}")


def on_disconnect(client, userdata, flags, reason_code, properties):
    """Cập nhật trạng thái khi mất kết nối MQTT."""
    global mqtt_connected
    mqtt_connected = False
    print(f"[MQTT] Disconnected from broker: {reason_code}")


def on_message(client, userdata, msg):
    """Xử lý dữ liệu cảm biến nhận được từ ESP32."""

    global latest_data
    global last_data_monotonic
    global last_db_save_time

    try:
        payload = msg.payload.decode("utf-8")
        data = json.loads(payload)

        required_fields = [
            "temperature",
            "humidity",
            "light",
            "status",
        ]

        for field in required_fields:
            if field not in data:
                print(f"[MQTT] Missing field: {field}")
                return

        record = {
            "temperature": float(data["temperature"]),
            "humidity": float(data["humidity"]),
            "light": str(data["light"]),
            "status": str(data["status"]),
            "buzzer_muted": bool(data.get("buzzer_muted", False)),
            "received_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }

        with data_lock:
            latest_data = record
            last_data_monotonic = time.monotonic()
            sensor_history.appendleft(record)

        now = time.monotonic()

        if now - last_db_save_time >= DB_SAVE_INTERVAL:
            last_db_save_time = now
            save_sensor_data(record)

        print("[MQTT] Received sensor data:")
        print(record)

    except (UnicodeDecodeError, json.JSONDecodeError,
            ValueError, TypeError) as error:

        print(f"[MQTT] Invalid message: {error}")

    except Exception as error:
        print(f"[MQTT] Error processing message: {error}")


mqtt_client = mqtt.Client(
    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    client_id=f"weather-backend-{uuid.uuid4().hex[:8]}",
)

mqtt_client.on_connect = on_connect
mqtt_client.on_disconnect = on_disconnect
mqtt_client.on_message = on_message


# ==================================================
# FRONTEND STATIC ROUTES
# ==================================================

@app.route("/", methods=["GET"])
def serve_frontend_index():
    """Phục vụ trang web chính tại http://localhost:5000."""
    return send_from_directory(FRONTEND_DIR, "index.html")


# ==================================================
# REST API
# ==================================================

@app.route("/api/health", methods=["GET"])
def health_check():
    """Kiểm tra trạng thái backend."""
    return jsonify({
        "status": "ok",
        "service": "weather-station-backend",
        "mqtt_connected": mqtt_connected,
    })


def _get_lan_ip():
    """Tìm địa chỉ IPv4 LAN thực tế của laptop để điện thoại quét QR truy cập."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
            return ip
    except OSError:
        pass

    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        candidates = []
        for info in infos:
            addr = info[4][0]
            if not addr.startswith("127.") and not addr.startswith("169.254."):
                candidates.append(addr)
        for prefix in ("192.168.", "10."):
            for addr in candidates:
                if addr.startswith(prefix):
                    return addr
        if candidates:
            return candidates[0]
    except OSError:
        pass

    return None


@app.route("/api/lan-info", methods=["GET"])
def get_lan_qr_info():
    """Trả về IP LAN, URL truy cập và mã QR SVG cho điện thoại."""
    port_raw = str(request.args.get("port", "5000")).strip()
    port = int(port_raw) if port_raw.isdigit() else 5000

    ip = _get_lan_ip()
    if not ip:
        return jsonify({
            "error": "Laptop chưa kết nối WiFi hoặc mạng LAN."
        }), 404

    url = f"http://{ip}:{port}"
    qr_img = qrcode.make(
        url,
        image_factory=qrcode.image.svg.SvgPathImage,
        box_size=10,
        border=2,
    )
    buf = io.BytesIO()
    qr_img.save(buf)

    return jsonify({
        "ip": ip,
        "port": port,
        "url": url,
        "qr_svg": buf.getvalue().decode("utf-8"),
    })


@app.route("/api/wifi/status", methods=["GET"])
def get_wifi_status_over_usb():
    """Kiểm tra WiFi hiện tại mà ESP32 đang kết nối qua USB."""
    prefix, payload, port_name, err_resp = _send_esp32_command(
        b"@@STATUS\n",
        ("@@STATUS_RESULT:",),
        timeout_sec=4.0,
        timeout_detail="không phản hồi trạng thái WiFi kịp thời.",
    )
    if err_resp is not None:
        return err_resp

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"Dữ liệu trạng thái từ ESP32 ({port_name}) không hợp lệ: {exc}"}), 500

    return jsonify({
        "port": port_name,
        "connected": bool(parsed.get("connected")),
        "ssid": parsed.get("ssid", ""),
        "ip": parsed.get("ip", ""),
        "rssi": parsed.get("rssi", 0),
        "mqtt": bool(parsed.get("mqtt")),
    })


@app.route("/api/wifi/disconnect", methods=["POST"])
def disconnect_wifi_over_usb():
    """Ngắt kết nối WiFi hiện tại trên ESP32 qua USB."""
    prefix, payload, port_name, err_resp = _send_esp32_command(
        b"@@DISCONNECT\n",
        ("@@DISCONNECT_OK:",),
        timeout_sec=4.0,
        timeout_detail="không phản hồi lệnh ngắt WiFi kịp thời.",
    )
    if err_resp is not None:
        return err_resp

    global latest_data, last_data_monotonic
    with data_lock:
        latest_data = None
        last_data_monotonic = 0.0

    return jsonify({"ok": True, "port": port_name})


@app.route("/api/wifi/scan", methods=["GET"])
def scan_wifi_over_usb():
    """Tự nhận mạch ESP32 qua USB và quét các mạng WiFi 2.4GHz xung quanh."""
    prefix, payload, port_name, err_resp = _send_esp32_command(
        b"@@SCAN\n",
        ("@@SCAN_RESULT:",),
        timeout_sec=9.0,
        timeout_detail="không trả kết quả quét WiFi kịp thời.",
    )
    if err_resp is not None:
        return err_resp

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"Kết quả quét từ ESP32 ({port_name}) không hợp lệ: {exc}"}), 500

    if not parsed.get("ok"):
        return jsonify({
            "error": parsed.get("error", "Quét WiFi trên ESP32 thất bại.")
        }), 500

    return jsonify({
        "port": port_name,
        "networks": parsed.get("networks", []),
    })


@app.route("/api/wifi/connect", methods=["POST"])
def connect_wifi_over_usb():
    """Gửi SSID và mật khẩu xuống ESP32 qua USB (chỉ lưu RAM)."""
    body = request.get_json(silent=True) or {}
    ssid = str(body.get("ssid", "")).strip()
    password = str(body.get("password", ""))

    if not ssid:
        return jsonify({"error": "Thiếu tên WiFi (SSID)."}), 400

    for ch in ("\t", "\r", "\n"):
        if ch in ssid or ch in password:
            return jsonify({"error": "Tên WiFi hoặc mật khẩu chứa ký tự điều khiển không hợp lệ."}), 400

    cmd = f"@@CONNECT\t{ssid}\t{password}\n".encode("utf-8")
    prefix, payload, port_name, err_resp = _send_esp32_command(
        cmd,
        ("@@WIFI_OK:", "@@WIFI_ERR:"),
        timeout_sec=18.0,
        timeout_detail="phản hồi quá lâu khi kết nối WiFi.",
    )
    if err_resp is not None:
        return err_resp

    if prefix == "@@WIFI_ERR:":
        return jsonify({"error": payload or "ESP32 không kết nối được WiFi."}), 400

    try:
        info = json.loads(payload)
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"Phản hồi WiFi từ ESP32 ({port_name}) không hợp lệ: {exc}"}), 500

    return jsonify({
        "ok": True,
        "port": port_name,
        "ssid": info.get("ssid", ssid),
        "ip": info.get("ip", ""),
    })


@app.route("/api/sensor/latest", methods=["GET"])
def get_latest_sensor_data():
    """Lấy dữ liệu cảm biến mới nhất từ RAM (quá 8 giây không có tin mới coi như Offline)."""

    with data_lock:
        data = latest_data
        last_seen = last_data_monotonic

    if data is None or (time.monotonic() - last_seen) > SENSOR_STALE_TIMEOUT:
        return jsonify({
            "online": False,
            "message": "Chưa nhận được dữ liệu mới từ ESP32",
        }), 200

    return jsonify({
        **data,
        "online": True,
    })


@app.route("/api/sensor/recent", methods=["GET"])
def get_recent_sensor_data():
    """Lấy tối đa 50 bản ghi gần nhất trong RAM theo thứ tự thời gian tăng dần để vẽ biểu đồ."""
    try:
        limit = int(request.args.get("limit", 16))
    except ValueError:
        return jsonify({"error": "limit phải là số nguyên"}), 400

    limit = max(1, min(limit, 50))

    with data_lock:
        recent = list(sensor_history)[:limit]

    recent.reverse()
    return jsonify({
        "count": len(recent),
        "data": recent,
    })


@app.route("/api/buzzer", methods=["POST"])
def control_buzzer_over_mqtt():
    """Điều khiển bật/tắt tiếng còi báo động trên ESP32 qua MQTT."""
    if not mqtt_connected:
        return jsonify({
            "error": "Backend chưa kết nối được MQTT broker.",
        }), 503

    body = request.get_json(silent=True) or {}
    if "mute" not in body:
        return jsonify({"error": "Thiếu tham số 'mute'."}), 400

    mute = bool(body.get("mute"))
    command = "MUTE" if mute else "UNMUTE"

    info = mqtt_client.publish(MQTT_CONTROL_TOPIC, command, qos=1)
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        return jsonify({"error": "Không thể gửi lệnh điều khiển qua MQTT."}), 500

    with data_lock:
        if latest_data is not None:
            latest_data["buzzer_muted"] = mute

    return jsonify({"ok": True, "muted": mute})


@app.route("/api/sensor/history", methods=["GET"])
def get_sensor_history():
    """Lấy lịch sử cảm biến từ SQLite."""

    try:
        limit = int(request.args.get("limit", 20))
    except ValueError:
        return jsonify({
            "error": "limit phải là số nguyên",
        }), 400

    limit = max(1, min(limit, 100))

    conn = None
    try:
        conn = get_db_connection()
        rows = conn.execute(
            """
            SELECT
                id,
                temperature,
                humidity,
                light,
                status,
                received_at
            FROM sensor_data
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        records = [dict(row) for row in rows]
        return jsonify({
            "count": len(records),
            "storage": "sqlite",
            "data": records,
        })

    except sqlite3.Error as error:
        print(f"[SQLite] History query failed: {error}")

        return jsonify({
            "error": "Không thể truy vấn lịch sử dữ liệu",
        }), 500

    finally:
        if conn is not None:
            conn.close()


# ==================================================
# START SERVER
# ==================================================

def _ensure_stdio_streams():
    """Tránh lỗi NoneType.write hoặc cp1252 UnicodeEncodeError khi chạy PyInstaller --windowed."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8", errors="replace"))
            continue

        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
                continue
            except Exception:
                pass

        enc = (getattr(stream, "encoding", "") or "").lower()
        if "utf" not in enc:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8", errors="replace"))


def _is_backend_already_running():
    """Kiểm tra cổng 5000 đã có backend chạy sẵn chưa."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:5000/api/health", timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False


def _launch_desktop_window():
    """Mở cửa sổ ứng dụng desktop riêng bằng pywebview (Edge WebView2)."""
    if webview is None:
        return False

    icon_candidate = os.path.join(FRONTEND_DIR, "favicon.ico")
    icon_path = icon_candidate if os.path.isfile(icon_candidate) else None

    try:
        webview.create_window(
            title="Enderwood IoT Weather Station",
            url="http://127.0.0.1:5000",
            width=1280,
            height=820,
            min_size=(960, 640),
            background_color="#0e0e0e",
        )
        webview.start(icon=icon_path)
        return True
    except Exception as exc:
        print(f"[WebView] Khong the mo cua so desktop: {exc}")
        return False


if __name__ == "__main__":
    _ensure_stdio_streams()

    is_frozen = getattr(sys, "frozen", False)
    use_desktop = (is_frozen or "--desktop" in sys.argv) and (
        os.getenv("NO_AUTO_BROWSER") != "1"
    )
    should_open_browser = (os.getenv("AUTO_OPEN_BROWSER") == "1") and (
        os.getenv("NO_AUTO_BROWSER") != "1"
    )

    if _is_backend_already_running():
        print("[Flask] Backend dang chay san tai http://localhost:5000")
        if use_desktop:
            if not _launch_desktop_window():
                webbrowser.open("http://localhost:5000")
        elif should_open_browser:
            webbrowser.open("http://localhost:5000")
        sys.exit(0)

    print(f"[SQLite] Initializing database at {DB_PATH}...")

    try:
        ensure_sensor_table()
        print("[SQLite] Ready")
    except sqlite3.Error as error:
        print(f"[SQLite] Initialization failed: {error}")

    print("[MQTT] Starting connection...")

    mqtt_client.connect_async(
        MQTT_HOST,
        MQTT_PORT,
        keepalive=20,
    )

    mqtt_client.loop_start()

    print("[Flask] Starting backend on http://localhost:5000")

    if use_desktop:
        http_server = make_server("0.0.0.0", 5000, app, threaded=True)
        server_thread = Thread(target=http_server.serve_forever, daemon=True)
        server_thread.start()

        try:
            opened = _launch_desktop_window()
            if not opened:
                webbrowser.open("http://localhost:5000")
                server_thread.join()
        finally:
            http_server.shutdown()
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
    else:
        if should_open_browser:
            Timer(0.9, lambda: webbrowser.open("http://localhost:5000")).start()

        app.run(
            host="0.0.0.0",
            port=5000,
            debug=False,
        )
