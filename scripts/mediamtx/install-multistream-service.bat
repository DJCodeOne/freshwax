@echo off
REM ============================================================================
REM  install-multistream-service.bat
REM  Installs the FreshWax multistream controller as a permanent NSSM service
REM  (auto-start on boot), matching the other FreshWax-* services.
REM
REM  >>> RIGHT-CLICK -> "Run as administrator" <<<  (service install needs elevation)
REM
REM  Re-runnable. It hands over from any standalone controller first (so they
REM  don't double-up), then installs + starts the service. Expect a ~10-15s blip
REM  on Twitch/YouTube during the handover; the website-audio bridge is untouched.
REM ============================================================================

set NSSM=C:\Users\Owner\nssm\nssm-2.24\win64\nssm.exe
set PWSH=C:\Program Files\PowerShell\7\pwsh.exe
set SCRIPT=C:\mediamtx\multistream-relay.ps1
set SVC=FreshWax-Multistream

echo Handing over from any standalone (non-service) controller...
REM Stop a hand-launched controller so it doesn't conflict with the service
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pwsh.exe'\" | Where-Object { $_.CommandLine -like '*multistream-relay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
REM Kill its relay ffmpeg (producer + Twitch/YouTube/DJ copies all reference
REM freshwax-main). The icecast-bridge reads 'icecast-live', so it is NOT matched.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -like '*freshwax-main*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Installing service %SVC%...
"%NSSM%" stop %SVC% >nul 2>&1
"%NSSM%" remove %SVC% confirm >nul 2>&1
"%NSSM%" install %SVC% "%PWSH%"
"%NSSM%" set %SVC% AppParameters "-NoProfile -File %SCRIPT%"
"%NSSM%" set %SVC% AppDirectory C:\mediamtx
"%NSSM%" set %SVC% Start SERVICE_AUTO_START
"%NSSM%" set %SVC% AppStdout C:\mediamtx\multistream-service.log
"%NSSM%" set %SVC% AppStderr C:\mediamtx\multistream-service.log
"%NSSM%" set %SVC% AppRotateFiles 1
"%NSSM%" set %SVC% AppRotateBytes 10485760
"%NSSM%" set %SVC% AppExit Default Restart
"%NSSM%" set %SVC% AppRestartDelay 5000
"%NSSM%" set %SVC% DisplayName "FreshWax Multistream"
"%NSSM%" set %SVC% Description "Relays the live stream to Twitch + YouTube (Quick Sync encode-once, auto-reconnect)."

echo Starting service...
"%NSSM%" start %SVC%
echo.
"%NSSM%" status %SVC%
echo.
echo Done. %SVC% is installed (auto-start on boot) and started.
echo It will detect the live source and reconnect Twitch/YouTube within ~10-15s.
echo Logs: C:\mediamtx\multistream-relay.log  (service stdout: multistream-service.log)
pause
