@echo off
REM ============================================================================
REM  relay-secrets.example.bat  —  TEMPLATE.
REM  Copy to relay-secrets.bat (next to the relay .bat scripts on the host) and
REM  fill in the real values. relay-secrets.bat is gitignored — NEVER commit it.
REM  Loaded via `call "%~dp0relay-secrets.bat"` by the start/stop relay scripts.
REM ============================================================================
set FRESHWAX_TWITCH_URL=rtmp://live.twitch.tv/live/YOUR_FRESHWAX_TWITCH_STREAM_KEY
set FRESHWAX_YOUTUBE_URL=rtmp://a.rtmp.youtube.com/live2/YOUR_FRESHWAX_YOUTUBE_STREAM_KEY
set SERVER_KEY=YOUR_STREAM_SERVER_KEY
