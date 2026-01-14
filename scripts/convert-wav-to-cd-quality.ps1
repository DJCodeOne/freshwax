# convert-wav-to-cd-quality.ps1
# Converts high-resolution WAV files to CD quality (44.1kHz/16bit)
# and uploads them back to R2

param(
    [string]$ReleaseId = "dj_bakkus_FW-1767896005916",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Configuration
$R2Bucket = "freshwax-releases"
$CdnBase = "https://cdn.freshwax.co.uk"
$TempDir = "$env:TEMP\freshwax-convert"

# Track info for Bakkus 24 Story EP
$tracks = @(
    @{
        Name = "24 STORY"
        FileName = "24 STORY-FINAL MASTER- 08-12-25.wav"
        R2Path = "releases/dj_bakkus_the_24_story_ep_1767896005916"
    },
    @{
        Name = "DEEP CUTZ"
        FileName = "DEEP CUTZ- FINAL MASTER- 08-12-25.wav"
        R2Path = "releases/dj_bakkus_the_24_story_ep_1767896005916"
    }
)

Write-Host "=== WAV to CD Quality Converter ===" -ForegroundColor Cyan
Write-Host "Release: $ReleaseId"
Write-Host "Temp directory: $TempDir"
Write-Host ""

# Create temp directory
if (-not (Test-Path $TempDir)) {
    New-Item -ItemType Directory -Path $TempDir | Out-Null
}

foreach ($track in $tracks) {
    $trackName = $track.Name
    $fileName = $track.FileName
    $r2Path = $track.R2Path

    # Use simple filenames without spaces for local processing
    $safeFileName = $fileName -replace ' ', '_'
    $sourceUrl = "$CdnBase/$r2Path/$([uri]::EscapeDataString($fileName))"
    $localOriginal = Join-Path $TempDir "original_$safeFileName"
    $localConverted = Join-Path $TempDir "converted_$safeFileName"
    $r2FullPath = "$r2Path/$fileName"

    Write-Host "Processing: $trackName" -ForegroundColor Yellow
    Write-Host "  Source: $sourceUrl"

    if ($DryRun) {
        Write-Host "  [DRY RUN] Would download, convert, and upload" -ForegroundColor Magenta
        continue
    }

    # Step 1: Download the original file
    Write-Host "  Downloading original..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $sourceUrl -OutFile $localOriginal -UseBasicParsing
        $originalSize = (Get-Item $localOriginal).Length
        Write-Host "  Original size: $([math]::Round($originalSize / 1MB, 2)) MB" -ForegroundColor Gray
    }
    catch {
        Write-Host "  ERROR downloading: $_" -ForegroundColor Red
        continue
    }

    # Step 2: Get original file info
    Write-Host "  Analyzing original file..." -ForegroundColor Gray
    $ffprobeOutput = & ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,bits_per_sample,channels -of csv=p=0 "$localOriginal" 2>&1
    Write-Host "  Original format (sample_rate,channels,bits): $ffprobeOutput" -ForegroundColor Gray

    # Step 3: Convert to 44.1kHz/16bit using ffmpeg
    Write-Host "  Converting to 44.1kHz/16bit..." -ForegroundColor Gray

    # Run ffmpeg directly with proper quoting
    & ffmpeg -i "$localOriginal" -ar 44100 -sample_fmt s16 -c:a pcm_s16le -y "$localConverted" 2>&1 | Out-Null

    if (-not (Test-Path $localConverted)) {
        Write-Host "  ERROR: Converted file not created" -ForegroundColor Red
        continue
    }

    $convertedSize = (Get-Item $localConverted).Length
    $savings = $originalSize - $convertedSize
    $savingsPercent = [math]::Round(($savings / $originalSize) * 100, 1)

    Write-Host "  Converted size: $([math]::Round($convertedSize / 1MB, 2)) MB" -ForegroundColor Green
    Write-Host "  Savings: $([math]::Round($savings / 1MB, 2)) MB ($savingsPercent%)" -ForegroundColor Green

    # Step 4: Upload to R2 (overwrite original)
    Write-Host "  Uploading to R2..." -ForegroundColor Gray
    Write-Host "  R2 path: $r2FullPath"

    try {
        # Use Start-Process to handle the wrangler command properly
        $uploadPath = "$R2Bucket/$r2FullPath"
        Write-Host "  Upload target: $uploadPath"

        $wranglerArgs = @("wrangler", "r2", "object", "put", $uploadPath, "--file", $localConverted, "--content-type", "audio/wav")
        $result = & npx @wranglerArgs 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ERROR uploading: $result" -ForegroundColor Red
            continue
        }
        Write-Host "  Uploaded successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "  ERROR uploading: $_" -ForegroundColor Red
        continue
    }

    # Cleanup
    Remove-Item $localOriginal -Force -ErrorAction SilentlyContinue
    Remove-Item $localConverted -Force -ErrorAction SilentlyContinue

    Write-Host ""
}

Write-Host "=== Conversion Complete ===" -ForegroundColor Cyan
Write-Host "Run the check-file-sizes endpoint to verify the new sizes."
