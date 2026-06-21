@echo off
REM Start Placeholder Relay Script
REM Combines Icecast audio with placeholder video and sends to freshwax-main
REM This is for "placeholder" broadcast mode - audio-only with static image

echo %date% %time% - Starting placeholder relay >> C:\mediamtx\relay-debug.log

REM Check if Icecast is streaming (port 8000)
curl -s -o nul -w "%%{http_code}" http://localhost:8000/live | findstr "200" >nul
if errorlevel 1 (
    echo %date% %time% - Icecast not streaming, skipping placeholder relay >> C:\mediamtx\relay-debug.log
    exit /b 0
)

echo Starting placeholder video + Icecast audio relay to freshwax-main...

REM Combine placeholder image with Icecast audio and send to freshwax-main
start /b "" "C:\ffmpeg\bin\ffmpeg.exe" -hide_banner -re -loop 1 -i "C:\icecast\freshwax-audio-placeholder.png" -f mp3 -i "http://localhost:8000/live" -map 0:v -map 1:a -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -r 30 -b:v 500k -c:a aac -b:a 192k -f flv "rtmp://localhost:1935/live/freshwax-main" > C:\mediamtx\placeholder-relay.log 2>&1

echo Placeholder relay started
echo %date% %time% - Placeholder relay started >> C:\mediamtx\relay-debug.log
