@echo off
rem ============================================================
rem  HMI Designer - CUSTOMER SIDE: native window + built-in backend
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files
rem  depending on the active console code page.
rem
rem  What it does:
rem    starts the backend inside this process, opens a WebView2
rem    native window on the runtime page, and when the window is
rem    CLOSED the service stops too - the port is released, no
rem    background process left, no stop_server.bat needed.
rem    Runs WINDOWLESS (no cmd box); all logs go to
rem    logs\hmi-YYYY-MM-DD.log (one file per day).
rem
rem  Usage:
rem    start_hmi_window.bat                window on /run (no login)
rem    start_hmi_window.bat --fullscreen   touch panel / kiosk
rem    start_hmi_window.bat --edit         designer / (needs login)
rem    start_hmi_window.bat --port 9000    another port (busy -> auto picks a free one)
rem    start_hmi_window.bat --mcp-live     let local hmi-mcp edit this visible window
rem
rem  Needs: Python + pywebview  (run install_desktop.bat once)
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PY="
rem Prefer windowless python (pyw/pythonw) so no console window pops up
where pyw >nul 2>nul && set "PY=pyw -3"
if not defined PY where pythonw >nul 2>nul && set "PY=pythonw"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo [ERROR] Python not found. Install Python 3.8+ and tick "Add Python to PATH".
  echo         https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

rem "start" detaches it: this cmd window closes right away.
rem All logs are written to logs\hmi-YYYY-MM-DD.log (daily rotation).
start "" %PY% "server\hmi_desktop.py" %*
endlocal
