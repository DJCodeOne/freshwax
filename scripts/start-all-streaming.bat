@echo off
echo ================================================
echo   FreshWax Streaming Services - Startup Script
echo ================================================
echo.

REM Set paths
set MEDIAMTX_PATH=C:\mediamtx
set ICECAST_PATH=C:\Program Files (x86)\Icecast
set CLOUDFLARED_PATH=C:\cloudflared
set FRESHWAX_PATH=C:\Users\Owner\freshwax
set SCRIPTS_PATH=%FRESHWAX_PATH%\scripts

REM Create logs directory if needed
if not exist "%MEDIAMTX_PATH%\logs" mkdir "%MEDIAMTX_PATH%\logs"

echo [1/5] Starting MediaMTX (HLS/RTMP server on ports 8888/1935)...
cd /d %MEDIAMTX_PATH%
start /b "" "%MEDIAMTX_PATH%\mediamtx.exe" > "%MEDIAMTX_PATH%\mediamtx.log" 2>&1

timeout /t 2 /nobreak > nul

echo [2/5] Starting Icecast (Audio streaming on port 8000)...
if exist "%ICECAST_PATH%\bin\icecast.exe" (
    copy /Y "C:\icecast\icecast.xml" "%ICECAST_PATH%\icecast.xml" > nul 2>&1
    start /b "" "%ICECAST_PATH%\bin\icecast.exe" -c "C:\icecast\icecast.xml"
) else (
    echo    WARNING: Icecast not installed at %ICECAST_PATH%
)

timeout /t 2 /nobreak > nul

echo [3/5] Starting Playlist Server (port 8088)...
cd /d %SCRIPTS_PATH%
start /b "" node "%SCRIPTS_PATH%\playlist-server.cjs" > "%MEDIAMTX_PATH%\playlist-server.log" 2>&1

timeout /t 1 /nobreak > nul

echo [4/5] Starting Relay Server (port 8765)...
start /b "" node "%SCRIPTS_PATH%\audio-relay.cjs" > "%MEDIAMTX_PATH%\relay-server.log" 2>&1

timeout /t 2 /nobreak > nul

echo [5/5] Starting Cloudflared Tunnel...
cd /d %CLOUDFLARED_PATH%
start /b "" "%CLOUDFLARED_PATH%\cloudflared.exe" tunnel --config "C:\Users\Owner\.cloudflared\config.yml" run > "%MEDIAMTX_PATH%\cloudflared-tunnel.log" 2>&1

timeout /t 5 /nobreak > nul

echo.
echo ================================================
echo   All streaming services started!
echo ================================================
echo.
echo Services running:
echo   - MediaMTX:     http://localhost:8888 (HLS), rtmp://localhost:1935
echo   - Icecast:      http://localhost:8000
echo   - Playlist:     http://localhost:8088
echo   - Relay:        http://localhost:8765
echo   - Cloudflared:  Tunnels active
echo.
echo Public URLs:
echo   - stream.freshwax.co.uk   (HLS streaming)
echo   - icecast.freshwax.co.uk  (Icecast/BUTT)
echo   - playlist.freshwax.co.uk (Playlist MP3s)
echo   - relay.freshwax.co.uk    (External radio relay)
echo.
echo Logs stored in: %MEDIAMTX_PATH%\
echo.
