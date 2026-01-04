# Retry failed downloads (files with .part extension)
$folder = "H:\FreshWax-Backup"
$ytdlp = "C:\Users\Owner\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe"
$archiveFile = "$folder\downloaded.txt"

# Find all .part files and extract video IDs
$partFiles = Get-ChildItem -Path $folder -Filter "*.part"
$total = $partFiles.Count

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Retrying $total failed downloads" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if ($total -eq 0) {
    Write-Host "No .part files found!" -ForegroundColor Green
    Read-Host "Press Enter to close"
    exit 0
}

# Extract video IDs from filenames (format: Title [VIDEO_ID].ext.part)
$videoIds = @()
foreach ($file in $partFiles) {
    # Extract ID from filename like "Title [VIDEO_ID].mp3.part"
    if ($file.Name -match '\[([a-zA-Z0-9_-]{11})\]') {
        $videoIds += $matches[1]
    }
    # Delete the .part file
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Host "Removed: $($file.Name)" -ForegroundColor Yellow
}

# Remove these IDs from the archive so they can be re-downloaded
Write-Host ""
Write-Host "Removing $($videoIds.Count) entries from archive..." -ForegroundColor Cyan

if (Test-Path $archiveFile) {
    $archiveContent = Get-Content $archiveFile
    $newArchive = $archiveContent | Where-Object {
        $line = $_
        $shouldKeep = $true
        foreach ($id in $videoIds) {
            if ($line -match $id) {
                $shouldKeep = $false
                break
            }
        }
        $shouldKeep
    }
    $newArchive | Set-Content $archiveFile
    Write-Host "Archive updated" -ForegroundColor Green
}

Write-Host ""
Write-Host "Starting download of $($videoIds.Count) videos..." -ForegroundColor Cyan
Write-Host ""

# Create temp URL file
$tempUrlFile = "$folder\retry-urls.txt"
$videoIds | ForEach-Object { "https://www.youtube.com/watch?v=$_" } | Set-Content $tempUrlFile

# Run yt-dlp
$ytdlpArgs = @(
    "--batch-file", $tempUrlFile,
    "--download-archive", $archiveFile,
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "-o", "$folder\%(title)s [%(id)s].%(ext)s",
    "--no-overwrites",
    "--ignore-errors",
    "--no-abort-on-error",
    "--retries", "5",
    "--sleep-interval", "2",
    "--max-sleep-interval", "10",
    "--write-info-json",
    "--write-thumbnail",
    "--embed-thumbnail",
    "--add-metadata",
    "--progress"
)

& $ytdlp @ytdlpArgs

# Cleanup
Remove-Item $tempUrlFile -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Retry complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Read-Host "Press Enter to close"
