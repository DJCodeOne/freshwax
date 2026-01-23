@echo off
:: FreshWax Playlist Server - Auto-Restart Wrapper
:: This script keeps the playlist server running indefinitely
:: It will restart automatically if the server crashes

title FreshWax Playlist Server (Auto-Restart)
cd /d "%~dp0"

set LOG_DIR=..\logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo.
echo ========================================
echo   FreshWax Playlist Server
echo   Auto-Restart Mode Enabled
echo ========================================
echo.
echo Press Ctrl+C to stop the server
echo.

:loop
echo [%date% %time%] Starting playlist server...
echo [%date% %time%] Starting playlist server >> "%LOG_DIR%\playlist-server-restarts.log"

node playlist-server.cjs 2>&1 | tee -a "%LOG_DIR%\playlist-server.log"

echo.
echo [%date% %time%] Server stopped unexpectedly!
echo [%date% %time%] Server stopped >> "%LOG_DIR%\playlist-server-restarts.log"
echo Restarting in 5 seconds...
timeout /t 5 /nobreak > nul
goto loop
