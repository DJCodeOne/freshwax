@echo off
echo ================================================
echo   FreshWax Streaming Services - Shutdown
echo ================================================
echo.

echo Stopping Cloudflared...
taskkill /IM cloudflared.exe /F 2>nul

echo Stopping MediaMTX...
taskkill /IM mediamtx.exe /F 2>nul

echo Stopping Icecast...
taskkill /IM icecast.exe /F 2>nul

echo Stopping Node.js servers (playlist + relay)...
REM Kill node processes running our scripts
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| findstr "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | findstr /i "playlist-server\|audio-relay" >nul && taskkill /PID %%a /F 2>nul
)

echo.
echo All streaming services stopped.
echo.
