@echo off
rem ============================================================
rem  HMI Designer - legacy entry point (delegates to start_server.bat)
rem ============================================================
cd /d "%~dp0"
call "%~dp0start_server.bat" %*