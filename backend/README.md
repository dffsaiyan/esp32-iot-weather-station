## Cài đặt & Chạy Backend (Flask + SQLite)

```powershell
cd backend
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python app.py
```

- Cơ sở dữ liệu **SQLite** (`weather_station.db`) và bảng `sensor_data` tự động được khởi tạo khi chạy `app.py`, không cần cài thêm MySQL hay XAMPP.
- Hoặc chạy trực tiếp file `start.bat` ở thư mục gốc để mở backend kèm giao diện web tại `http://localhost:5000`.
