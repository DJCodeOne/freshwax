@echo off
echo Creating scheduled task for FreshWax Streaming Services...
schtasks /create /tn "FreshWax Streaming" /tr "C:\Users\Owner\freshwax\scripts\start-all-streaming.bat" /sc onlogon /rl highest /f
if %errorlevel%==0 (
    echo.
    echo SUCCESS! Streaming services will start automatically at login.
    echo.
    echo You can also:
    echo   - Start manually: C:\Users\Owner\freshwax\scripts\start-all-streaming.bat
    echo   - Stop all: C:\Users\Owner\freshwax\scripts\stop-all-streaming.bat
) else (
    echo.
    echo Failed to create task. Try running this script as Administrator.
)
pause
