@echo off
chcp 65001 >nul
setlocal
title Weather Station - ESP32 Flask

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%backend"
set "VENV_PY=%BACKEND_DIR%\.venv\Scripts\python.exe"
set "URL=http://localhost:5000"

if not exist "%VENV_PY%" (
    echo [ERROR] Khong tim thay moi truong Python tai:
    echo         "%VENV_PY%"
    echo Hay tao moi truong backend\.venv truoc khi chay.
    pause
    exit /b 1
)

"%VENV_PY%" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/health', timeout=1)" >nul 2>&1
if %errorlevel%==0 (
    echo Backend dang chay san tai %URL%. Dang mo trinh duyet...
    start "" "%URL%"
    exit /b 0
)

echo ==================================================
echo   WEATHER STATION - ESP32 ^& FLASK BACKEND
echo   Web UI: %URL%
echo   Dong cua so nay hoac bam Ctrl+C de tat server.
echo ==================================================
echo.

cd /d "%BACKEND_DIR%"
set "AUTO_OPEN_BROWSER=1"
"%VENV_PY%" -u app.py

echo.
echo Server da dung.
pause
