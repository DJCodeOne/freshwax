@echo off
REM download-playlist.bat
REM Downloads all FreshWax playlist videos to H:\FreshWax-Backup

SET OUTPUT_DIR=H:\FreshWax-Backup
SET URLS_FILE=%OUTPUT_DIR%\playlist-urls.txt
SET ARCHIVE_FILE=%OUTPUT_DIR%\downloaded.txt

echo ========================================
echo FreshWax Playlist Backup Downloader
echo ========================================
echo.

REM yt-dlp path (installed via winget)
SET YTDLP=C:\Users\Owner\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe

REM Check if yt-dlp exists
IF NOT EXIST "%YTDLP%" (
    echo ERROR: yt-dlp not found at %YTDLP%
    echo.
    echo Install it using: winget install yt-dlp
    echo.
    pause
    exit /b 1
)

REM Check if URLs file exists
IF NOT EXIST "%URLS_FILE%" (
    echo ERROR: URLs file not found at %URLS_FILE%
    echo.
    echo Run this first: node scripts/export-playlist-urls.js
    echo.
    pause
    exit /b 1
)

echo Output directory: %OUTPUT_DIR%
echo URLs file: %URLS_FILE%
echo.

REM Count total URLs
for /f %%A in ('type "%URLS_FILE%" ^| find /c /v ""') do set TOTAL=%%A
echo Total videos to process: %TOTAL%
echo.

REM Check already downloaded
IF EXIST "%ARCHIVE_FILE%" (
    for /f %%A in ('type "%ARCHIVE_FILE%" ^| find /c /v ""') do set DONE=%%A
    echo Already downloaded: %DONE%
    echo.
)

echo Starting download...
echo Press Ctrl+C to pause (progress is saved)
echo.

REM Download with yt-dlp
REM Options:
REM   -f "bv*[height<=720]+ba/b[height<=720]" = Best video up to 720p + best audio
REM   --download-archive = Skip already downloaded videos
REM   -o = Output filename template
REM   --no-overwrites = Don't overwrite existing files
REM   --ignore-errors = Continue on errors
REM   --sleep-interval = Be nice to YouTube servers
REM   --retries = Retry failed downloads
REM   --write-info-json = Save video metadata
REM   --write-thumbnail = Save thumbnail

"%YTDLP%" ^
    --batch-file "%URLS_FILE%" ^
    --download-archive "%ARCHIVE_FILE%" ^
    -x --audio-format mp3 --audio-quality 0 ^
    -o "%OUTPUT_DIR%\%%(title)s [%%(id)s].%%(ext)s" ^
    --no-overwrites ^
    --ignore-errors ^
    --no-abort-on-error ^
    --sleep-interval 1 ^
    --max-sleep-interval 5 ^
    --retries 3 ^
    --write-info-json ^
    --write-thumbnail ^
    --embed-thumbnail ^
    --add-metadata ^
    --progress

echo.
echo ========================================
echo Download session complete!
echo ========================================
echo.
echo Check %OUTPUT_DIR% for your files.
echo Run this script again to resume/retry failed downloads.
echo.
pause
