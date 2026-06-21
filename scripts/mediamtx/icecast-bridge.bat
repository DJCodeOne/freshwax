@echo off
REM ============================================================
REM  icecast → MediaMTX HLS bridge
REM  Continuously pulls audio from local icecast /live mount and
REM  re-publishes to MediaMTX as RTMP so it can be served as HLS.
REM
REM  ffmpeg will restart in a loop if it exits (e.g. BUTT
REM  disconnects). MediaMTX runOnInitRestart also restarts this
REM  script if it terminates.
REM ============================================================

:loop
"C:\mediamtx\ffmpeg.exe" -hide_banner -loglevel warning ^
  -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 ^
  -reconnect_on_http_error 4xx,5xx ^
  -reconnect_delay_max 5 ^
  -i http://localhost:8010/live ^
  -c:a aac -b:a 192k -ar 44100 -ac 2 ^
  -f flv rtmp://localhost:1935/icecast-live >> "C:\mediamtx\icecast-bridge.log" 2>&1
echo [icecast-bridge] ffmpeg exited, restarting in 5s... >> "C:\mediamtx\icecast-bridge.log"
REM Use ping instead of timeout — timeout requires console input which fails under Windows services (session 0)
ping -n 6 127.0.0.1 >nul
goto loop
