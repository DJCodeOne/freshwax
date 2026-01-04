# Retry failed audio conversions
$ffmpeg = "C:\ffmpeg\bin\ffmpeg.exe"
$backupDir = "H:\FreshWax-Backup"
$failedLog = "$backupDir\failed-conversions.txt"

# Clear previous failed log
if (Test-Path $failedLog) { Remove-Item $failedLog }

# Remove test file if exists
if (Test-Path "$backupDir\test-convert.mp3") { Remove-Item "$backupDir\test-convert.mp3" }

$files = Get-ChildItem "$backupDir\*.webm", "$backupDir\*.m4a" -ErrorAction SilentlyContinue
$total = $files.Count
$converted = 0
$failed = 0
$skipped = 0

Write-Host "Retrying $total failed conversions..." -ForegroundColor Cyan
Write-Host ""

foreach ($file in $files) {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $mp3Path = "$backupDir\$baseName.mp3"

    # Skip if MP3 already exists
    if (Test-Path $mp3Path) {
        Write-Host "[$($converted + $failed + $skipped + 1)/$total] SKIP (exists): $baseName" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    Write-Host "[$($converted + $failed + $skipped + 1)/$total] Converting: $($file.Name)" -ForegroundColor Yellow

    # Run ffmpeg and redirect stderr to null (it outputs progress to stderr)
    $process = Start-Process -FilePath $ffmpeg -ArgumentList "-y", "-i", "`"$($file.FullName)`"", "-vn", "-acodec", "libmp3lame", "-q:a", "0", "`"$mp3Path`"" -NoNewWindow -Wait -PassThru -RedirectStandardError "$backupDir\ffmpeg-temp.log"

    # Check if MP3 was created and has content
    if ((Test-Path $mp3Path) -and ((Get-Item $mp3Path).Length -gt 1000)) {
        Write-Host "  SUCCESS" -ForegroundColor Green
        $converted++
        # Remove source file after successful conversion
        Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "  FAILED" -ForegroundColor Red
        $failed++
        Add-Content $failedLog "$($file.Name)"
        # Remove failed MP3 if it exists
        if (Test-Path $mp3Path) { Remove-Item $mp3Path -Force -ErrorAction SilentlyContinue }
    }
}

# Cleanup temp log
if (Test-Path "$backupDir\ffmpeg-temp.log") { Remove-Item "$backupDir\ffmpeg-temp.log" -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Conversion complete!" -ForegroundColor Cyan
Write-Host "  Converted: $converted" -ForegroundColor Green
Write-Host "  Skipped (already exist): $skipped" -ForegroundColor DarkGray
Write-Host "  Failed: $failed" -ForegroundColor Red
if ($failed -gt 0) {
    Write-Host "  Failed files logged to: $failedLog" -ForegroundColor Yellow
}
Write-Host "========================================" -ForegroundColor Cyan
