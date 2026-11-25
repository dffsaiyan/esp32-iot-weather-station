# Hệ Thống Trạm Quan Trắc Thời Tiết Mini (ESP32 IoT)

Đồ án cuối kỳ môn **Hệ thống IoT và Ứng dụng**. Nhóm mình xây dựng một trạm đo thời tiết mini dùng **ESP32** đọc nhiệt độ, độ ẩm, ánh sáng theo thời gian thực, hiển thị cảnh báo tại chỗ và gửi dữ liệu lên giao diện web/điện thoại qua **MQTT**.

## 1. Phần cứng & Sơ đồ nối chân (`src/main.cpp`)
- **Vi điều khiển:** ESP32-DevKit
- **Cảm biến & thiết bị ngoại vi:**

| Linh kiện | Chân ESP32 | Ghi chú |
|---|---|---|
| Cảm biến nhiệt độ & độ ẩm **DHT11** | `GPIO 27` (`D27`) | Đọc mỗi 2 giây |
| Cảm biến ánh sáng **LDR** (DO) | `GPIO 34` (`D34`) | Trả về trạng thái Sáng / Tối |
| Màn hình **OLED SSD1306** (128x64, I2C `0x3C`) | `GPIO 21` (SDA), `GPIO 22` (SCL) | Hiện thông số và IP WiFi |
| **LED Xanh / Vàng / Đỏ** | `GPIO 26` / `GPIO 32` / `GPIO 25` | Báo mức Ổn định / Cảnh báo / Nguy hiểm |
| **Còi Buzzer** | `GPIO 23` (`D23`) | Kêu khi đạt mức Nguy hiểm |

## 2. Nguyên lý hoạt động & Tính năng
- **Phân mức cảnh báo tự động:**
  - **Ổn định (`NORMAL`):** Nhiệt độ `< 33°C` và Độ ẩm `< 76%` → LED xanh sáng, còi tắt.
  - **Cảnh báo (`WARNING`):** Nhiệt độ `>= 33°C` hoặc Độ ẩm `>= 76%` → LED vàng sáng.
  - **Nguy hiểm (`DANGER`):** Nhiệt độ `>= 37°C` hoặc Độ ẩm `>= 85%` → LED đỏ sáng, còi kêu.
- **Cài đặt WiFi qua cổng USB (không lưu mật khẩu):**
  - Cắm dây USB nối ESP32 với máy tính rồi vào mục **Cài đặt** trên web để chọn tên WiFi (2.4GHz) và nhập mật khẩu.
  - Mạch dùng `WiFi.persistent(false)` nên mật khẩu chỉ nằm tạm trên RAM, rút điện là mất (tránh lộ mật khẩu và dễ đổi WiFi khi mang đi bảo vệ).
- **Giao tiếp 2 chiều qua MQTT (`broker.emqx.io`, port `1883`):**
  - ESP32 đẩy JSON lên topic `iot/esp32/weather/giang0811/data` mỗi `2` giây.
  - Web gửi lệnh tắt/bật còi báo động xuống ESP32 qua topic `iot/esp32/weather/giang0811/control` khi hệ thống đang ở trạng thái Nguy hiểm.
- **Web Dashboard, Lưu trữ SQLite & Xem trên điện thoại:**
  - Backend **Flask** (`backend/app.py`) nhận dữ liệu MQTT, tự lưu lịch sử vào **SQLite** (`weather_station.db`) mỗi `10` giây và vẽ biểu đồ 2 trục tự co giãn. Nếu quá `8` giây không có tin mới từ mạch thì giao diện tự khóa về `Offline`.
  - Giao diện tự co giãn cho màn hình điện thoại; trên web có nút **"Mở trên điện thoại"** tạo mã **QR** theo IP LAN của máy tính để điện thoại bắt chung WiFi quét vào xem và điều khiển trực tiếp.

## 3. Cấu trúc thư mục chính
```text
├── src/main.cpp          # Code firmware cho ESP32 (PlatformIO / Arduino)
├── include/config.h      # Ghi chú cấu hình WiFi (không hardcode mật khẩu)
├── backend/app.py        # Server Flask, kết nối MQTT, SQLite, giao tiếp USB Serial & tạo QR
├── frontend/             # Giao diện web (HTML/CSS/JS + Chart.js)
├── start.bat             # Mở nhanh backend và trình duyệt web
└── build_exe.bat         # Đóng gói thành app Windows (WeatherStation.exe)
```

## 4. Cách chạy nhanh
1. **Nạp code ESP32:** Mở project bằng PlatformIO trên VS Code và bấm Upload (`pio run -t upload`).
2. **Chạy trên máy tính:** Chạy file `start.bat` (trước đó cài môi trường Python trong `backend/.venv` theo `backend/requirements.txt`), trình duyệt sẽ mở tại `http://localhost:5000`.
3. **Đóng gói app Desktop (tùy chọn):** Chạy `build_exe.bat` để tạo thư mục `dist/WeatherStation/WeatherStation.exe`.
