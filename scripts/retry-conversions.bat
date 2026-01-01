@echo off
setlocal enabledelayedexpansion

set FFMPEG=C:\ffmpeg\bin\ffmpeg.exe
set BACKUPDIR=H:\FreshWax-Backup
set FAILEDLOG=%BACKUPDIR%\failed-conversions.txt

echo ========================================
echo Retrying Failed Conversions
echo ========================================
echo.

REM Clear failed log
if exist "%FAILEDLOG%" del "%FAILEDLOG%"

set CONVERTED=0
set FAILED=0
set TOTAL=0

REM Count files first
for %%f in ("%BACKUPDIR%\*.webm" "%BACKUPDIR%\*.m4a") do set /a TOTAL+=1
echo Found %TOTAL% files to convert
echo.

REM Process each file
for %%f in ("%BACKUPDIR%\*.webm" "%BACKUPDIR%\*.m4a") do (
    set "INFILE=%%f"
    set "BASENAME=%%~nf"
    set "MP3FILE=%BACKUPDIR%\%%~nf.mp3"

    echo Converting: %%~nxf

    REM Check if MP3 already exists
    if exist "!MP3FILE!" (
        echo   SKIP - already exists
    ) else (
        "%FFMPEG%" -y -i "!INFILE!" -vn -acodec libmp3lame -q:a 0 "!MP3FILE!" >nul 2>&1

        if exist "!MP3FILE!" (
            echo   SUCCESS
            set /a CONVERTED+=1
            del "!INFILE!" >nul 2>&1
        ) else (
            echo   FAILED
            set /a FAILED+=1
            echo %%~nxf>>"%FAILEDLOG%"
        )
    )
)

echo.
echo ========================================
echo Conversion complete!
echo   Converted: %CONVERTED%
echo   Failed: %FAILED%
if %FAILED% gtr 0 echo   Failed files logged to: %FAILEDLOG%
echo ========================================
