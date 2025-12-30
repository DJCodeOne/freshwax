# download-playlist.ps1
# PowerShell script for downloading FreshWax playlist with better progress tracking

$OutputDir = "H:\FreshWax-Backup"
$UrlsFile = "$OutputDir\playlist-urls.txt"
$ArchiveFile = "$OutputDir\downloaded.txt"
$LogFile = "$OutputDir\download-log.txt"

# Banner
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FreshWax Playlist Backup Downloader" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# yt-dlp path (installed via winget)
$ytdlpPath = "C:\Users\Owner\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe"

# Check yt-dlp exists
if (-not (Test-Path $ytdlpPath)) {
    Write-Host "ERROR: yt-dlp not found at $ytdlpPath" -ForegroundColor Red
    Write-Host ""
    Write-Host "Install using: winget install yt-dlp" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Check URLs file
if (-not (Test-Path $UrlsFile)) {
    Write-Host "ERROR: URLs file not found!" -ForegroundColor Red
    Write-Host "Run first: node scripts/export-playlist-urls.js"
    exit 1
}

# Count URLs
$urls = Get-Content $UrlsFile
$totalCount = $urls.Count
Write-Host "Total videos: $totalCount" -ForegroundColor Green

# Count already downloaded
$downloadedCount = 0
if (Test-Path $ArchiveFile) {
    $downloadedCount = (Get-Content $ArchiveFile | Measure-Object -Line).Lines
}
Write-Host "Already downloaded: $downloadedCount" -ForegroundColor Green
Write-Host "Remaining: $($totalCount - $downloadedCount)" -ForegroundColor Yellow
Write-Host ""

# Estimate time
$remainingVideos = $totalCount - $downloadedCount
$estimatedMinutes = $remainingVideos * 2 # ~2 min per video average
$estimatedHours = [math]::Round($estimatedMinutes / 60, 1)
Write-Host "Estimated time remaining: ~$estimatedHours hours" -ForegroundColor Cyan
Write-Host "(This will vary based on video length and connection speed)"
Write-Host ""

# Confirm
$confirm = Read-Host "Start download? (y/n)"
if ($confirm -ne 'y') {
    Write-Host "Cancelled."
    exit 0
}

# Start timestamp
$startTime = Get-Date
Add-Content -Path $LogFile -Value "=== Download session started: $startTime ==="

Write-Host ""
Write-Host "Downloading... Press Ctrl+C to pause (progress is saved)" -ForegroundColor Yellow
Write-Host ""

# Run yt-dlp
$ytdlpArgs = @(
    "--batch-file", $UrlsFile,
    "--download-archive", $ArchiveFile,
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "-o", "$OutputDir\%(title)s [%(id)s].%(ext)s",
    "--no-overwrites",
    "--ignore-errors",
    "--no-abort-on-error",
    "--sleep-interval", "1",
    "--max-sleep-interval", "5",
    "--retries", "3",
    "--write-info-json",
    "--write-thumbnail",
    "--embed-thumbnail",
    "--add-metadata",
    "--progress",
    "--console-title"
)

& $ytdlpPath @ytdlpArgs 2>&1 | Tee-Object -FilePath $LogFile -Append

# End timestamp
$endTime = Get-Date
$duration = $endTime - $startTime
Add-Content -Path $LogFile -Value "=== Download session ended: $endTime (Duration: $duration) ==="

# Final count
$finalDownloaded = 0
if (Test-Path $ArchiveFile) {
    $finalDownloaded = (Get-Content $ArchiveFile | Measure-Object -Line).Lines
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Session Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Downloaded this session: $($finalDownloaded - $downloadedCount)" -ForegroundColor Green
Write-Host "Total downloaded: $finalDownloaded / $totalCount" -ForegroundColor Green
Write-Host "Duration: $duration" -ForegroundColor Cyan
Write-Host ""
Write-Host "Files saved to: $OutputDir" -ForegroundColor Yellow
Write-Host "Run this script again to resume/retry failed downloads."
Write-Host ""
