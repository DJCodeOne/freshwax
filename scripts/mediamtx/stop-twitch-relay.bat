@echo off
setlocal enabledelayedexpansion
REM Stop Twitch Relay Script with Fade Out
REM Fades to black before ending both Twitch streams

REM Load secrets (FRESHWAX_TWITCH_URL etc.) from the local, gitignored file.
call "%~dp0relay-secrets.bat"

REM Kill all current live stream relays
taskkill /f /im ffmpeg.exe >nul 2>&1

REM Wait a moment
timeout /t 1 /nobreak >nul

REM Stream fade out to Fresh Wax Twitch
start /b "" "C:\ffmpeg\bin\ffmpeg.exe" -f lavfi -i "color=c=black:s=1920x1080:r=30:d=4" -f lavfi -i "anullsrc=r=44100:cl=stereo" -vf "fade=t=in:st=0:d=0.5,fade=t=out:st=2:d=2" -c:v libx264 -preset ultrafast -tune zerolatency -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -c:a aac -b:a 128k -ar 44100 -t 4 -f flv "%FRESHWAX_TWITCH_URL%" >nul 2>&1

REM Check if DJ had a personal Twitch stream
if exist C:\mediamtx\current-dj-twitch-key.txt (
    set /p DJ_TWITCH_KEY=<C:\mediamtx\current-dj-twitch-key.txt

    if defined DJ_TWITCH_KEY (
        if not "!DJ_TWITCH_KEY!"=="" (
            set DJ_TWITCH_URL=rtmp://live.twitch.tv/live/!DJ_TWITCH_KEY!
            echo Fading out DJ's Twitch channel...

            REM Stream fade out to DJ's Twitch
            start /b "" "C:\ffmpeg\bin\ffmpeg.exe" -f lavfi -i "color=c=black:s=1920x1080:r=30:d=4" -f lavfi -i "anullsrc=r=44100:cl=stereo" -vf "fade=t=in:st=0:d=0.5,fade=t=out:st=2:d=2" -c:v libx264 -preset ultrafast -tune zerolatency -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -c:a aac -b:a 128k -ar 44100 -t 4 -f flv "!DJ_TWITCH_URL!" >nul 2>&1
        )
    )

    REM Clean up the key file
    del C:\mediamtx\current-dj-twitch-key.txt >nul 2>&1
)

REM Wait for the fade out to complete
timeout /t 5 /nobreak >nul

REM Kill any remaining FFmpeg processes
taskkill /f /im ffmpeg.exe >nul 2>&1

REM Clean up temp files
del C:\mediamtx\dj-twitch-response.json >nul 2>&1

echo Twitch relay stopped with fade out
endlocal
