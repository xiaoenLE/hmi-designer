@echo off
rem ============================================================
rem  HMI Designer - stop the backend service
rem  Usage:
rem    stop_server.bat            stop the service on port 8866
rem    stop_server.bat 9000       stop the service on another port
rem  Use this when the console window is gone but the port is
rem  still occupied.
rem ============================================================
setlocal enabledelayedexpansion

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8866"

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do (
  echo   killing PID %%P listening on port %PORT% ...
  taskkill /f /pid %%P >nul 2>nul
  set "FOUND=1"
)

if defined FOUND (
  echo   stopped the service on port %PORT%.
) else (
  echo   nothing is listening on port %PORT%.
)
echo.
ping -n 4 127.0.0.1 >nul 2>nul
endlocal