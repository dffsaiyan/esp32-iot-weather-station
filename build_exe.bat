@echo off
chcp 65001 >nul
setlocal
title Build WeatherStation Desktop App (.exe)

set "ROOT_DIR=%~dp0"
set "VENV_PY=%ROOT_DIR%backend\.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo [ERROR] Khong tim thay "%VENV_PY%".
    exit /b 1
)

cd /d "%ROOT_DIR%"

echo [1/3] Kiem tra PyInstaller va pywebview...
"%VENV_PY%" -c "import PyInstaller, webview" >nul 2>&1
if errorlevel 1 (
    echo       Dang cai dat PyInstaller va pywebview vao backend\.venv...
    "%VENV_PY%" -m pip install pyinstaller pywebview
    if errorlevel 1 (
        echo [ERROR] Cai dat PyInstaller/pywebview that bai.
        exit /b 1
    )
)

echo [2/3] Dang dong goi WeatherStation.exe (Desktop App)...
"%VENV_PY%" -m PyInstaller ^
  --onedir ^
  --windowed ^
  --noconfirm ^
  --clean ^
  --name WeatherStation ^
  --icon "%ROOT_DIR%frontend\favicon.ico" ^
  --add-data "%ROOT_DIR%frontend;frontend" ^
  --hidden-import serial.tools.list_ports_windows ^
  --hidden-import serial.win32 ^
  --collect-all webview ^
  --collect-all pythonnet ^
  --collect-all clr_loader ^
  --distpath "%ROOT_DIR%dist" ^
  --workpath "%ROOT_DIR%build" ^
  --specpath "%ROOT_DIR%build" ^
  "%ROOT_DIR%backend\app.py"

if errorlevel 1 (
    echo [ERROR] Dong goi that bai.
    exit /b 1
)

echo [3/3] Dang nen ban portable (.zip)...
powershell -NoProfile -Command "Compress-Archive -Path '%ROOT_DIR%dist\WeatherStation' -DestinationPath '%ROOT_DIR%dist\WeatherStation_Portable.zip' -Force"
if errorlevel 1 (
    echo [ERROR] Nen file zip that bai.
    exit /b 1
)

echo.
echo ==================================================
echo   DONG GOI DESKTOP APP THANH CONG!
echo   App chay ngay : %ROOT_DIR%dist\WeatherStation\WeatherStation.exe
echo   File zip gui  : %ROOT_DIR%dist\WeatherStation_Portable.zip
echo ==================================================
