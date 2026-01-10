# convert-release-to-mp3.ps1
# Converts WAV files in a release folder to MP3 and uploads to R2
# Usage: .\convert-release-to-mp3.ps1 -ReleaseId "dj_bakkus_FW-1767896005916"

param(
    [Parameter(Mandatory=$true)]
    [string]$ReleaseId,

    [string]$FfmpegPath = "C:\ffmpeg\bin\ffmpeg.exe",
    [string]$Bitrate = "320k",
    [string]$TempDir = "$env:TEMP\freshwax-convert"
)

$ErrorActionPreference = "Stop"

# Configuration - load from .env
$envFile = Join-Path $PSScriptRoot "../.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
        }
    }
}

$R2_ACCOUNT_ID = $env:R2_ACCOUNT_ID
$R2_ACCESS_KEY_ID = $env:R2_ACCESS_KEY_ID
$R2_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY
$R2_BUCKET = "freshwax-releases"
$FIREBASE_API_KEY = $env:FIREBASE_API_KEY
$ADMIN_KEY = $env:ADMIN_KEY

if (-not $R2_ACCESS_KEY_ID -or -not $R2_SECRET_ACCESS_KEY) {
    Write-Error "R2 credentials not found in .env"
    exit 1
}

Write-Host "Converting release: $ReleaseId" -ForegroundColor Cyan

# Create temp directory
if (-not (Test-Path $TempDir)) {
    New-Item -ItemType Directory -Path $TempDir | Out-Null
}

# Fetch release from Firebase
Write-Host "Fetching release data from Firebase..." -ForegroundColor Yellow
$releaseUrl = "https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/releases/${ReleaseId}?key=$FIREBASE_API_KEY"
$releaseResponse = Invoke-RestMethod -Uri $releaseUrl -Method Get

if (-not $releaseResponse.fields) {
    Write-Error "Release not found: $ReleaseId"
    exit 1
}

$r2FolderPath = $releaseResponse.fields.r2FolderPath.stringValue
Write-Host "R2 folder: $r2FolderPath" -ForegroundColor Gray

# Get tracks
$tracks = $releaseResponse.fields.tracks.arrayValue.values
if (-not $tracks) {
    Write-Error "No tracks found in release"
    exit 1
}

Write-Host "Found $($tracks.Count) tracks" -ForegroundColor Green

$updatedTracks = @()

foreach ($track in $tracks) {
    $trackFields = $track.mapValue.fields
    $trackName = $trackFields.trackName.stringValue
    $wavUrl = $trackFields.wavUrl.stringValue

    Write-Host "`nProcessing: $trackName" -ForegroundColor Cyan
    Write-Host "  WAV URL: $wavUrl" -ForegroundColor Gray

    # Check if already has MP3 (different from WAV)
    $mp3Url = $trackFields.mp3Url.stringValue
    if ($mp3Url -and $mp3Url -ne $wavUrl -and $mp3Url -match "\.mp3$") {
        Write-Host "  Already has MP3, skipping" -ForegroundColor Yellow
        $updatedTracks += $track
        continue
    }

    # Download WAV
    $wavFilename = [System.IO.Path]::GetFileName([System.Uri]::UnescapeDataString($wavUrl))
    $wavPath = Join-Path $TempDir $wavFilename

    Write-Host "  Downloading WAV..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $wavUrl -OutFile $wavPath -UseBasicParsing
    } catch {
        Write-Warning "  Failed to download: $_"
        $updatedTracks += $track
        continue
    }

    $wavSize = (Get-Item $wavPath).Length / 1MB
    Write-Host "  Downloaded: $([math]::Round($wavSize, 1)) MB" -ForegroundColor Gray

    # Convert to MP3
    $mp3Filename = [System.IO.Path]::ChangeExtension($wavFilename, ".mp3")
    $mp3Path = Join-Path $TempDir $mp3Filename

    Write-Host "  Converting to MP3 ($Bitrate)..." -ForegroundColor Yellow
    $ffmpegArgs = @(
        "-i", $wavPath,
        "-codec:a", "libmp3lame",
        "-b:a", $Bitrate,
        "-y",
        $mp3Path
    )

    $process = Start-Process -FilePath $FfmpegPath -ArgumentList $ffmpegArgs -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        Write-Warning "  FFmpeg conversion failed"
        $updatedTracks += $track
        continue
    }

    $mp3Size = (Get-Item $mp3Path).Length / 1MB
    Write-Host "  Converted: $([math]::Round($mp3Size, 1)) MB ($(([math]::Round($mp3Size / $wavSize * 100, 0)))% of WAV)" -ForegroundColor Green

    # Upload MP3 to R2 using rclone or aws cli
    # For simplicity, we'll use a direct HTTP PUT with AWS Signature
    $r2Mp3Key = "$r2FolderPath/$mp3Filename"
    $r2Mp3Url = "https://cdn.freshwax.co.uk/$r2Mp3Key"

    Write-Host "  Uploading to R2: $r2Mp3Key" -ForegroundColor Yellow

    # Use wrangler r2 object put
    $wranglerArgs = @(
        "r2", "object", "put",
        "$R2_BUCKET/$r2Mp3Key",
        "--file", $mp3Path,
        "--content-type", "audio/mpeg"
    )

    $env:CLOUDFLARE_ACCOUNT_ID = $R2_ACCOUNT_ID

    try {
        $wranglerProcess = Start-Process -FilePath "npx" -ArgumentList (@("wrangler") + $wranglerArgs) -NoNewWindow -Wait -PassThru -WorkingDirectory (Join-Path $PSScriptRoot "..")
        if ($wranglerProcess.ExitCode -eq 0) {
            Write-Host "  Uploaded successfully" -ForegroundColor Green

            # Update track with new MP3 URL
            $newTrack = @{
                mapValue = @{
                    fields = @{
                        trackNumber = $trackFields.trackNumber
                        trackName = @{ stringValue = $trackName }
                        title = $trackFields.title
                        wavUrl = @{ stringValue = $wavUrl }
                        mp3Url = @{ stringValue = $r2Mp3Url }
                        previewUrl = @{ stringValue = $r2Mp3Url }
                        bpm = $trackFields.bpm
                        key = $trackFields.key
                        duration = $trackFields.duration
                        trackISRC = $trackFields.trackISRC
                        featured = $trackFields.featured
                        remixer = $trackFields.remixer
                        storage = @{ stringValue = "r2" }
                    }
                }
            }
            $updatedTracks += $newTrack
        } else {
            Write-Warning "  Upload failed"
            $updatedTracks += $track
        }
    } catch {
        Write-Warning "  Upload error: $_"
        $updatedTracks += $track
    }

    # Cleanup temp files
    Remove-Item $wavPath -Force -ErrorAction SilentlyContinue
    Remove-Item $mp3Path -Force -ErrorAction SilentlyContinue
}

# Update Firebase with new track URLs
Write-Host "`nUpdating Firebase release..." -ForegroundColor Yellow

$updatePayload = @{
    fields = @{
        tracks = @{
            arrayValue = @{
                values = $updatedTracks
            }
        }
    }
}

$updateUrl = "https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/releases/${ReleaseId}?updateMask.fieldPaths=tracks&key=$FIREBASE_API_KEY"

try {
    # Note: This requires authenticated access - may need admin API
    Write-Host "Track URLs prepared for update. Use admin panel to update Firebase." -ForegroundColor Yellow
    Write-Host "`nNew MP3 URLs:" -ForegroundColor Cyan
    foreach ($track in $updatedTracks) {
        $mp3 = $track.mapValue.fields.mp3Url.stringValue
        $name = $track.mapValue.fields.trackName.stringValue
        Write-Host "  $name : $mp3" -ForegroundColor White
    }
} catch {
    Write-Warning "Firebase update failed: $_"
}

Write-Host "`nConversion complete!" -ForegroundColor Green
Write-Host "Temp files cleaned from: $TempDir" -ForegroundColor Gray
