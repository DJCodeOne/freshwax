# Convert all MP4 files in FreshWax-Backup to MP3
$folder = "H:\FreshWax-Backup"
$ffmpeg = "C:\ffmpeg\bin\ffmpeg.exe"

$mp4Files = Get-ChildItem -Path $folder -Filter "*.mp4"
$total = $mp4Files.Count
$count = 0
$success = 0
$failed = 0

Write-Host "Converting $total MP4 files to MP3..." -ForegroundColor Cyan
Write-Host ""

foreach ($file in $mp4Files) {
    $count++
    $mp3Name = $file.Name -replace '\.mp4$', '.mp3'
    $mp3FullPath = Join-Path $folder $mp3Name

    Write-Host "[$count/$total] $($file.Name)" -ForegroundColor Yellow

    # Use direct invocation with proper escaping
    try {
        & $ffmpeg -i $file.FullName -codec:a libmp3lame -qscale:a 0 $mp3FullPath -y -hide_banner -loglevel warning 2>&1 | Out-Null

        if (Test-Path -LiteralPath $mp3FullPath) {
            Remove-Item -LiteralPath $file.FullName -Force
            Write-Host "  Done" -ForegroundColor Green
            $success++
        } else {
            Write-Host "  FAILED - MP3 not created" -ForegroundColor Red
            $failed++
        }
    } catch {
        Write-Host "  ERROR: $_" -ForegroundColor Red
        $failed++
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Conversion complete!" -ForegroundColor Cyan
Write-Host "Success: $success" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Cyan
Read-Host "Press Enter to close"
