@echo off
rem ============================================================
rem  Simulated PLC - Modbus TCP slave + web console
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files.
rem
rem  Usage:
rem    start_plc_sim.bat                         Modbus :502, web :8899
rem    start_plc_sim.bat --port 15020            use another Modbus port
rem    start_plc_sim.bat --web-port 8898         use another web port
rem    start_plc_sim.bat --import-csv vars.csv   preset data from a variable table
rem
rem  Then in the designer: click [PLC], connect to 127.0.0.1 : <port>, unit 1
rem  Stop: Ctrl+C or close this window
rem ============================================================
setlocal
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
echo   Starting simulated PLC ...  press Ctrl+C to stop
echo.
%PY% "server\plc_sim.py" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERROR] simulator exited with code %RC%
  echo         port busy -^> start_plc_sim.bat --port 15020
  echo.
  pause
)
endlocal