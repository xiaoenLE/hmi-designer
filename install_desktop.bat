@echo off
rem ============================================================
rem  HMI Designer - one-time setup for the native window client
rem  (start_hmi_window.bat). ASCII only on purpose.
rem
rem  Installs pywebview (the native window) and tells you if the
rem  Microsoft Edge WebView2 runtime is missing. WebView2 ships
rem  with Windows 10/11 (Edge), so most machines need nothing.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo [ERROR] Python not found. Install Python 3.8+ and tick "Add Python to PATH".
  echo.
  pause
  exit /b 1
)

echo.
echo   Installing pywebview ... (needs internet, ~a few MB)
echo.
%PY% -m pip install --upgrade pywebview
set "RC=%ERRORLEVEL%"

echo.
echo   Checking Microsoft Edge WebView2 runtime ...
if exist "%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application" (
  echo   OK - WebView2 runtime found.
) else (
  echo   [WARN] WebView2 runtime not found.
  echo          Windows 10/11 with Edge normally has it. If the window stays blank,
  echo          install "Evergreen Standalone Installer" from:
  echo          https://developer.microsoft.com/microsoft-edge/webview2/
)

echo.
if not "%RC%"=="0" (
  echo [ERROR] pip install failed with code %RC%
) else (
  echo   Done. Now run start_hmi_window.bat
)
echo.
pause
endlocal
