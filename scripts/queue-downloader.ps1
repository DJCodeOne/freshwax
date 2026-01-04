# queue-downloader.ps1
# Monitors the FreshWax queue and downloads YouTube tracks to H: drive
# Skips duplicates using archive file

$OutputDir = "H:\FreshWax-Backup"
$ArchiveFile = "$OutputDir\downloaded.txt"
$LogFile = "$OutputDir\queue-download-log.txt"
$ProcessedFile = "$OutputDir\queue-processed.txt"
$ApiUrl = "https://freshwax.co.uk/api/playlist/global"
$PollInterval = 30  # seconds

# yt-dlp path
$ytdlpPath = "C:\Users\Owner\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe"

# Banner
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FreshWax Queue Downloader" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Monitoring queue for YouTube tracks..." -ForegroundColor Yellow
Write-Host "Downloads saved to: $OutputDir" -ForegroundColor Yellow
Write-Host "Poll interval: $PollInterval seconds" -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Load already processed queue IDs (to avoid reprocessing)
$processedIds = @{}
if (Test-Path $ProcessedFile) {
    Get-Content $ProcessedFile | ForEach-Object { $processedIds[$_] = $true }
}

# Load downloaded video IDs from archive (to avoid re-downloading)
$downloadedIds = @{}
if (Test-Path $ArchiveFile) {
    Get-Content $ArchiveFile | ForEach-Object {
        if ($_ -match "youtube\s+(\w+)") {
            $downloadedIds[$matches[1]] = $true
        }
    }
}

Write-Host "Loaded $($processedIds.Count) processed queue items" -ForegroundColor Gray
Write-Host "Loaded $($downloadedIds.Count) already downloaded videos" -ForegroundColor Gray
Write-Host ""

function Download-YouTubeTrack {
    param (
        [string]$Url,
        [string]$VideoId,
        [string]$Title
    )

    # Check if already downloaded
    if ($downloadedIds.ContainsKey($VideoId)) {
        Write-Host "  [SKIP] Already downloaded: $Title" -ForegroundColor Gray
        return $true
    }

    Write-Host "  [DOWNLOAD] $Title" -ForegroundColor Green
    Write-Host "  URL: $Url" -ForegroundColor Gray

    # yt-dlp arguments for high quality audio + thumbnail + metadata
    $ytdlpArgs = @(
        $Url,
        "--download-archive", $ArchiveFile,
        "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "-o", "$OutputDir\%(title)s [%(id)s].%(ext)s",
        "--no-overwrites",
        "--write-info-json",
        "--write-thumbnail",
        "--embed-thumbnail",
        "--add-metadata",
        "--no-playlist",
        "--retries", "3"
    )

    try {
        $process = Start-Process -FilePath $ytdlpPath -ArgumentList $ytdlpArgs -NoNewWindow -Wait -PassThru

        if ($process.ExitCode -eq 0) {
            Write-Host "  [SUCCESS] Downloaded: $Title" -ForegroundColor Green
            $downloadedIds[$VideoId] = $true
            Add-Content -Path $LogFile -Value "[$(Get-Date)] Downloaded: $Title ($VideoId)"
            return $true
        } else {
            Write-Host "  [ERROR] Download failed (exit code: $($process.ExitCode))" -ForegroundColor Red
            Add-Content -Path $LogFile -Value "[$(Get-Date)] FAILED: $Title ($VideoId) - Exit code: $($process.ExitCode)"
            return $false
        }
    } catch {
        Write-Host "  [ERROR] Exception: $_" -ForegroundColor Red
        Add-Content -Path $LogFile -Value "[$(Get-Date)] EXCEPTION: $Title ($VideoId) - $_"
        return $false
    }
}

function Check-Queue {
    try {
        $response = Invoke-RestMethod -Uri $ApiUrl -Method Get -TimeoutSec 10

        if ($response.success -and $response.playlist.queue) {
            $queue = $response.playlist.queue
            $newTracks = 0

            foreach ($item in $queue) {
                # Skip if already processed this queue item
                if ($processedIds.ContainsKey($item.id)) {
                    continue
                }

                # Only process YouTube tracks (not autoplay/system tracks)
                if ($item.platform -eq "youtube" -and $item.addedBy -ne "system") {
                    $videoId = $item.embedId
                    $url = $item.url
                    $title = $item.title

                    # Clean URL (remove playlist params)
                    if ($url -match "youtube\.com/watch\?v=([^&]+)") {
                        $url = "https://www.youtube.com/watch?v=$($matches[1])"
                    }

                    Write-Host ""
                    Write-Host "[NEW] Found YouTube track in queue:" -ForegroundColor Cyan
                    Write-Host "  Title: $title" -ForegroundColor White
                    Write-Host "  Added by: $($item.addedByName)" -ForegroundColor Gray

                    # Download the track
                    $success = Download-YouTubeTrack -Url $url -VideoId $videoId -Title $title

                    if ($success) {
                        $newTracks++
                    }
                }

                # Mark as processed (even if download failed, don't retry same queue item)
                $processedIds[$item.id] = $true
                Add-Content -Path $ProcessedFile -Value $item.id
            }

            if ($newTracks -gt 0) {
                Write-Host ""
                Write-Host "[SUMMARY] Downloaded $newTracks new track(s)" -ForegroundColor Green
            }
        }
    } catch {
        Write-Host "[ERROR] Failed to fetch queue: $_" -ForegroundColor Red
    }
}

# Main loop
$iteration = 0
while ($true) {
    $iteration++
    $timestamp = Get-Date -Format "HH:mm:ss"

    Write-Host "[$timestamp] Checking queue... (poll #$iteration)" -ForegroundColor Gray

    Check-Queue

    Start-Sleep -Seconds $PollInterval
}
