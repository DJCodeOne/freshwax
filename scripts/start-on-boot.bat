@echo off
REM ================================================
REM  FreshWax Auto-Start Script
REM  Starts all streaming infrastructure on boot
REM  Place a shortcut to this in:
REM  %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
REM ================================================

set LOG=%USERPROFILE%\freshwax-boot.log
echo. >> "%LOG%"
echo ================================================ >> "%LOG%"
echo [%date% %time%] FreshWax services starting... >> "%LOG%"
echo ================================================ >> "%LOG%"

set MEDIAMTX_PATH=C:\mediamtx
set CLOUDFLARED_PATH=C:\cloudflared
set FRESHWAX_PATH=C:\Users\Owner\freshwax
set PM2_PATH=%APPDATA%\npm\pm2.cmd
set NODE_PATH=C:\Program Files\nodejs\node.exe

REM Wait for network to be ready
echo [%date% %time%] Waiting for network... >> "%LOG%"
timeout /t 15 /nobreak > nul

REM 1. Start MediaMTX (HLS/RTMP/WHIP server)
echo [%date% %time%] Starting MediaMTX... >> "%LOG%"
cd /d %MEDIAMTX_PATH%
start "" /b "%MEDIAMTX_PATH%\mediamtx.exe" > "%MEDIAMTX_PATH%\mediamtx.log" 2>&1
timeout /t 3 /nobreak > nul

REM 2. Start Cloudflared Tunnel
echo [%date% %time%] Starting Cloudflared Tunnel... >> "%LOG%"
cd /d %CLOUDFLARED_PATH%
start "" /b "%CLOUDFLARED_PATH%\cloudflared.exe" tunnel --config "%USERPROFILE%\.cloudflared\config.yml" run > "%MEDIAMTX_PATH%\cloudflared-tunnel.log" 2>&1
timeout /t 5 /nobreak > nul

REM 3. Start Playlist Server + Audio Relay via PM2
echo [%date% %time%] Starting PM2 services... >> "%LOG%"
cd /d %FRESHWAX_PATH%
call "%PM2_PATH%" resurrect > nul 2>&1
call "%PM2_PATH%" start ecosystem.config.cjs >> "%LOG%" 2>&1
timeout /t 3 /nobreak > nul

REM 4. Verify all services
echo [%date% %time%] Verifying services... >> "%LOG%"
tasklist | findstr /i "mediamtx" > nul 2>&1 && echo [OK] MediaMTX running >> "%LOG%" || echo [FAIL] MediaMTX NOT running >> "%LOG%"
tasklist | findstr /i "cloudflared" > nul 2>&1 && echo [OK] Cloudflared running >> "%LOG%" || echo [FAIL] Cloudflared NOT running >> "%LOG%"
call "%PM2_PATH%" status >> "%LOG%" 2>&1

echo [%date% %time%] Startup complete. >> "%LOG%"
echo ================================================ >> "%LOG%"
