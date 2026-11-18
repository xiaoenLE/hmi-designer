@echo off
rem ============================================================
rem  HMI Designer - quick start for the backend service
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files
rem  depending on the active console code page.
rem
rem  Usage:
rem    start_server.bat                 port 8866, opens the runtime page
rem    start_server.bat --port 9000     use another port
rem    start_server.bat --no-browser    do not open the browser
rem    start_server.bat --host 0.0.0.0  let other LAN machines connect
rem    start_server.bat --no-auth       dev only: drop the login gate
rem
rem  Pages:
rem    http://127.0.0.1:8866/run        runtime page (customer, no login)
rem    http://127.0.0.1:8866/           designer   (needs admin login)
rem    change the admin password:       set_password.bat myNewPassword
rem
rem  Stop: Ctrl+C, close this window, or run stop_server.bat
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Tells the backend how it was started, so that an in-app update
rem ("install now" in the designer) knows how to bring the service back.
rem See server/_restart.py.
set "HMI_LAUNCH=console-bat"

set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--port 8866"

rem -- preferred python launcher --
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo [ERROR] Python not found. Install Python 3.8+ and tick "Add Python to PATH".
  echo         https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting HMI Designer backend ...   press Ctrl+C to stop
echo   runtime page for the customer : http://127.0.0.1:8866/run
echo   designer (needs admin login)  : http://127.0.0.1:8866/
echo.
%PY% "server\server.py" %ARGS%
set "RC=%ERRORLEVEL%"

rem Exit code 0 after an in-app update = the service handed over to the
rem restart helper (server/_restart.py) and is already running again in the
rem background with the new code. Not an error - just say so and stop here.
if "%RC%"=="0" (
  if exist "server\data\_update\status.json" (
    echo.
    echo   [info] the service may have just been updated and restarted in the
    echo          background ^(no console window^). Open the page to check:
    echo          http://127.0.0.1:8866/run
    echo          update log: logs\update-YYYY-MM-DD.log
    echo          to stop it: stop_server.bat
    echo.
  )
)

if not "%RC%"=="0" (
  echo.
  echo [ERROR] service exited with code %RC%
  echo         port busy     -^> start_server.bat --port 9000
  echo         no permission -^> move the project to a writable folder
  echo         after an update -^> see logs\update-YYYY-MM-DD.log
  echo.
  pause
)
endlocal