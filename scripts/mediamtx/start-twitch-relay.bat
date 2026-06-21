@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM  start-twitch-relay.bat  —  OBS multistream (Quick Sync, encode-once)
REM ----------------------------------------------------------------------------
REM  Fired by MediaMTX pathDefaults runOnReady when a stream publishes.
REM
REM  Design (matches the BUTT path — CPU-light on the i7-6700K + HD 530):
REM    1. Encode the incoming OBS stream ONCE via Intel Quick Sync (h264_qsv)
REM       into freshwax-main. This normalises bitrate/keyframes for Twitch's
REM       limit and feeds the radio-station relays, with a 2s fade-in from black.
REM    2. Stream-COPY freshwax-main -> Fresh Wax Twitch / YouTube / DJ's Twitch
REM       (no re-encode — ~0 extra CPU). The single fade-in propagates to all.
REM
REM  Replaces the old design's two 6Mbps libx264 re-encodes (Twitch + DJ Twitch)
REM  with one Quick Sync encode. Original kept as start-twitch-relay.bat.bak.
REM ============================================================================

set FFMPEG=C:\ffmpeg\bin\ffmpeg.exe
set LOCAL_MAIN=rtmp://localhost:1935/live/freshwax-main

REM Load secrets (FRESHWAX_TWITCH_URL / FRESHWAX_YOUTUBE_URL / SERVER_KEY) from
REM the local, gitignored file next to this script.
call "%~dp0relay-secrets.bat"

set STREAM_KEY=%1
REM Strip the live/ prefix (MediaMTX passes the full path like live/fwx_xxx)
set STREAM_KEY=%STREAM_KEY:live/=%

echo %date% %time% - OBS relay invoked for: %STREAM_KEY% >> C:\mediamtx\relay-debug.log

REM --- RECURSION GUARD --------------------------------------------------------
REM We publish freshwax-main ourselves; pathDefaults runOnReady also fires for it.
REM Exit immediately so freshwax-main never re-triggers a second fan-out.
echo %STREAM_KEY% | findstr /B "freshwax-main" >nul
if not errorlevel 1 (
    echo %date% %time% - freshwax-main publish (our own output), skipping >> C:\mediamtx\relay-debug.log
    exit /b 0
)

REM Only OBS streams (fwx_*) drive this path. BUTT/audio is handled separately by
REM butt-multistream.ps1. Skip anything else (icecast bridge, etc).
echo %STREAM_KEY% | findstr /B "fwx_" >nul
if errorlevel 1 (
    echo %date% %time% - Not an OBS stream, skipping: %STREAM_KEY% >> C:\mediamtx\relay-debug.log
    exit /b 0
)

REM Wait a moment for the stream to stabilise
ping -n 3 127.0.0.1 >nul

echo ============================================
echo Fresh Wax OBS Multi-Platform Relay (Quick Sync)
echo Stream Key: %STREAM_KEY%
echo ============================================

REM 1. Quick Sync encode OBS -> freshwax-main (normalise + 2s fade-in, audio copy)
echo Encoding to freshwax-main via Quick Sync...
start "" /b "%FFMPEG%" -hide_banner -loglevel warning -i "rtmp://localhost:1935/live/%STREAM_KEY%" ^
  -vf "fade=t=in:st=0:d=2,format=nv12" ^
  -c:v h264_qsv -b:v 4000k -maxrate 6000k -bufsize 8000k -g 60 ^
  -c:a copy -f flv "%LOCAL_MAIN%" > C:\mediamtx\obs-main.log 2>&1

REM Give freshwax-main a few seconds to come up before copying from it
ping -n 5 127.0.0.1 >nul

REM 2. Stream-copy freshwax-main -> Fresh Wax Twitch (no re-encode)
echo Copying to Fresh Wax Twitch...
start "" /b "%FFMPEG%" -hide_banner -loglevel warning -i "%LOCAL_MAIN%" -c copy -f flv "%FRESHWAX_TWITCH_URL%" > C:\mediamtx\obs-twitch.log 2>&1

REM 3. Stream-copy freshwax-main -> Fresh Wax YouTube (no re-encode)
echo Copying to Fresh Wax YouTube...
start "" /b "%FFMPEG%" -hide_banner -loglevel warning -i "%LOCAL_MAIN%" -c copy -f flv "%FRESHWAX_YOUTUBE_URL%" > C:\mediamtx\obs-youtube.log 2>&1

REM 4. Fetch the YouTube live video ID (best-effort, so the site can link it)
ping -n 10 127.0.0.1 >nul
curl -s -X POST -H "Content-Type: application/json" -d "{\"streamKey\":\"live/%STREAM_KEY%\"}" "https://freshwax.co.uk/api/livestream/youtube-live-id" > C:\mediamtx\youtube-live-id-response.json 2>&1

REM 5. DJ's personal Twitch — key in the x-server-key HEADER (not a query param)
set "API_URL=https://freshwax.co.uk/api/livestream/dj-twitch-key?streamKey=live/%STREAM_KEY%"
curl -s -H "x-server-key: %SERVER_KEY%" "%API_URL%" > C:\mediamtx\dj-twitch-response.json 2>nul

if exist C:\mediamtx\dj-twitch-response.json (
    for /f "usebackq delims=" %%j in (`powershell -NoProfile -Command "try { $json = Get-Content 'C:\mediamtx\dj-twitch-response.json' -Raw | ConvertFrom-Json; if ($json.djTwitchKey -and $json.djTwitchKey -ne 'null') { $json.djTwitchKey } } catch { }"`) do set DJ_TWITCH_KEY=%%j

    if defined DJ_TWITCH_KEY (
        if not "!DJ_TWITCH_KEY!"=="" (
            echo !DJ_TWITCH_KEY!> C:\mediamtx\current-dj-twitch-key.txt
            echo Copying to DJ's personal Twitch...
            start "" /b "%FFMPEG%" -hide_banner -loglevel warning -i "%LOCAL_MAIN%" -c copy -f flv "rtmp://live.twitch.tv/live/!DJ_TWITCH_KEY!" > C:\mediamtx\obs-twitch-dj.log 2>&1
        )
    ) else (
        echo No DJ personal Twitch key found
    )
)

echo ============================================
echo OBS relay started for: %STREAM_KEY%
echo - Quick Sync encode -^> freshwax-main: ACTIVE
echo - Fresh Wax Twitch / YouTube (copy): ACTIVE
echo ============================================
echo %date% %time% - OBS relay started (QSV main + copy fan-out) >> C:\mediamtx\relay-debug.log
endlocal
