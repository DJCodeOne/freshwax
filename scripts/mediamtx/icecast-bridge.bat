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
REM Self-maintaining log: hard-cap at 10 MB so idle reconnect output (repeated 404s
REM while no source is connected) can never accumulate unbounded. Safe to truncate
REM here at the top of the loop — no ffmpeg child holds the file at this point.
if exist "C:\mediamtx\icecast-bridge.log" for %%A in ("C:\mediamtx\icecast-bridge.log") do if %%~zA GTR 10485760 type nul > "C:\mediamtx\icecast-bridge.log"

"C:\mediamtx\ffmpeg.exe" -hide_banner -loglevel error ^
  -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 ^
  -reconnect_on_http_error 4xx,5xx ^
  -reconnect_delay_max 5 ^
  -i http://localhost:8010/live ^
  -c:a aac -b:a 192k -ar 44100 -ac 2 ^
  -f flv rtmp://localhost:1935/icecast-live >> "C:\mediamtx\icecast-bridge.log" 2>&1
REM No per-cycle echo line: at -loglevel error ffmpeg already logs each failed attempt,
REM so an extra "restarting in 5s" line every loop was pure redundant volume while idle.
REM Use ping instead of timeout — timeout requires console input which fails under Windows services (session 0)
ping -n 6 127.0.0.1 >nul
goto loop
