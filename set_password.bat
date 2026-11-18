@echo off
rem ============================================================
rem  HMI Designer - set / change the admin password
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files
rem  depending on the active console code page.
rem
rem  Usage:
rem    set_password.bat myNewPassword     set the admin password
rem
rem  What it protects:
rem    http://<machine>:8866/       the designer (needs login)
rem    http://<machine>:8866/run    the runtime page for the customer (no login)
rem
rem  Forgot the password? Just run this again with a new one.
rem  Wipe it completely (no login at all): delete server\data\auth.json
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

if "%~1"=="" (
  echo.
  echo   Usage: set_password.bat myNewPassword
  echo   Example: set_password.bat hmi@2026
  echo.
  pause
  exit /b 1
)

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

%PY% "server\server.py" --set-password %1
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [ERROR] failed ^(code %RC%^)
) else (
  echo   Now open  http://127.0.0.1:8866/login  and log in with the new password.
  echo   The runtime page  http://127.0.0.1:8866/run  needs no password.
)
echo.
pause
endlocal
