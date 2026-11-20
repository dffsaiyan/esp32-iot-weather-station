# Enderwood IoT Weather Station (ESP32 + MQTT + Flask + SQLite)

Hệ thống trạm giám sát thời tiết thời gian thực sử dụng **ESP32-DevKit**, cảm biến **DHT11**, quang trở **LDR**, màn hình **OLED SSD1306**, **3 đèn LED**, **còi Buzzer**, giao tiếp 2 chiều qua **MQTT (`broker.emqx.io`)**, **Backend Flask + SQLite** và hỗ trợ đóng gói thành ứng dụng desktop Windows (`WeatherStation.exe`).

## Tính năng chính
- **Đo & cảnh báo tại chỗ (ESP32):**
  - Nhiệt độ & độ ẩm (`DHT11`, GPIO 27), ánh sáng (`LDR`, GPIO 34).
  - Hiển thị trực tiếp trên màn hình OLED I2C (`GPIO 21/22`) và phân mức cảnh báo bằng LED Xanh (`GPIO 26`) / Vàng (`GPIO 32`) / Đỏ (`GPIO 25`) + còi Buzzer (`GPIO 23`).
  - Ngưỡng nhiệt độ: Cảnh báo `>= 33.0°C`, Nguy hiểm `>= 37.0°C`; Độ ẩm: Cảnh báo `>= 76%`, Nguy hiểm `>= 85%`.
- **Cấu hình WiFi an toàn qua USB (RAM-only):**
  - Tự động nhận cổng COM ESP32, quét WiFi 2.4GHz, xem WiFi đang kết nối, đổi mạng hoặc ngắt kết nối ngay trên giao diện Cài đặt.
  - Dùng `WiFi.persistent(false)` — **không lưu mật khẩu WiFi** vào Flash/NVS của ESP32 hay file trên máy tính.
- **Giám sát & điều khiển 2 chiều qua MQTT:**
  - Tự động chuyển trạng thái `Offline` ↔ `Live` (quá 8 giây không có gói tin mới tự khóa về `Offline`).
  - Biểu đồ 2 trục Y thời gian thực (`°C` và `%`), bảng lịch sử tự lưu vào **SQLite** (`weather_station.db`) mỗi 10 giây.
  - Công tắc **Còi báo động** điều khiển 2 chiều qua MQTT (tự bật khi đạt ngưỡng Nguy hiểm, cho phép tắt/bật lại trong lúc Nguy hiểm, tự khóa khi hạ ngưỡng).

## Sơ đồ chân ESP32 (`src/main.cpp`)
| Thành phần | Chân trên ESP32 |
|---|---|
| DHT11 (DATA) | `GPIO 27` (`D27`) |
| Cảm biến ánh sáng LDR (`DO`) | `GPIO 34` (`D34`) |
| OLED SSD1306 (`SDA` / `SCL`) | `GPIO 21` (`D21`) / `GPIO 22` (`D22`) |
| LED Xanh / Vàng / Đỏ | `GPIO 26` / `GPIO 32` / `GPIO 25` |
| Còi Buzzer (`+`) | `GPIO 23` (`D23`) |

## Chạy & đóng gói
- **Nạp firmware ESP32:** Mở project bằng PlatformIO và chạy Upload (`pio run -t upload`).
- **Chạy chế độ Web trên máy:** Double-click `start.bat` (hoặc chạy `backend\.venv\Scripts\python.exe backend\app.py` và mở `http://localhost:5000`).
- **Đóng gói app Desktop `.exe`:** Chạy `build_exe.bat` để xuất `dist\WeatherStation\WeatherStation.exe` và `dist\WeatherStation_Portable.zip`.
