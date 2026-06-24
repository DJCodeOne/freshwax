@echo off
REM ============================================================================
REM  install-audio-processor-service.bat
REM  Installs the FreshWax audio processor as a permanent NSSM service
REM  (auto-start on boot), matching the other FreshWax-* services.
REM
REM  This is the local FFmpeg HTTP service on :8089 that converts uploaded WAVs
REM  into 320kbps MP3 during release upload. If it is NOT running, the uploader
REM  falls back to saving releases WAV-only. It is a plain Node script, so unlike
REM  the streaming services it did NOT come back after the last power cut — this
REM  service makes it auto-start so that can't happen again.
REM
REM  >>> RIGHT-CLICK -> "Run as administrator" <<<  (service install needs elevation)
REM
REM  Re-runnable. Stops any hand-launched processor first (frees port 8089),
REM  then installs + starts the service.
REM ============================================================================

set NSSM=C:\Users\Owner\nssm\nssm-2.24\win64\nssm.exe
set NODE=C:\Program Files\nodejs\node.exe
set SCRIPT=C:\Users\Owner\freshwax\scripts\audio-processor.cjs
set SVC=FreshWax-AudioProcessor

echo Stopping any hand-launched processor (frees port 8089)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*audio-processor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Installing service %SVC%...
"%NSSM%" stop %SVC% >nul 2>&1
"%NSSM%" remove %SVC% confirm >nul 2>&1
"%NSSM%" install %SVC% "%NODE%"
"%NSSM%" set %SVC% AppParameters "%SCRIPT%"
"%NSSM%" set %SVC% AppDirectory C:\Users\Owner\freshwax
"%NSSM%" set %SVC% Start SERVICE_AUTO_START
"%NSSM%" set %SVC% AppStdout C:\mediamtx\audio-processor-service.log
"%NSSM%" set %SVC% AppStderr C:\mediamtx\audio-processor-service.log
"%NSSM%" set %SVC% AppRotateFiles 1
"%NSSM%" set %SVC% AppRotateBytes 10485760
"%NSSM%" set %SVC% AppExit Default Restart
"%NSSM%" set %SVC% AppRestartDelay 5000
"%NSSM%" set %SVC% DisplayName "FreshWax - Audio Processor"
"%NSSM%" set %SVC% Description "Local FFmpeg audio conversion service on :8089 (uploaded WAV -> 320kbps MP3). Without it, releases save WAV-only. ffmpeg resolved via FFMPEG_PATH in freshwax\.env."

echo Starting service...
"%NSSM%" start %SVC%
echo.
"%NSSM%" status %SVC%
echo.
echo Done. %SVC% is installed (auto-start on boot) and started on http://localhost:8089
echo Verify:  curl http://localhost:8089/health   (expect r2Configured:true, ffmpeg:true)
echo Service log: C:\mediamtx\audio-processor-service.log
pause
