# Quick test of queue downloader logic
$ApiUrl = "https://freshwax.co.uk/api/playlist/global"
$ProcessedFile = "H:\FreshWax-Backup\queue-processed.txt"

Write-Host "Fetching queue..."
$response = Invoke-RestMethod -Uri $ApiUrl -Method Get -TimeoutSec 10

if ($response.success -and $response.playlist.queue) {
    Write-Host "Found $($response.playlist.queue.Count) items in queue"

    # Load processed IDs
    $processedIds = @{}
    if (Test-Path $ProcessedFile) {
        Get-Content $ProcessedFile | ForEach-Object { $processedIds[$_] = $true }
    }
    Write-Host "Already processed: $($processedIds.Count) items"

    foreach ($item in $response.playlist.queue) {
        $status = if ($processedIds.ContainsKey($item.id)) { "[SKIP]" } else { "[NEW]" }
        $isYoutube = $item.platform -eq "youtube"
        $isUser = $item.addedBy -ne "system"
        Write-Host "$status $($item.id) | $($item.platform) | addedBy=$($item.addedBy) | $($item.title)"

        if (-not $processedIds.ContainsKey($item.id) -and $isYoutube -and $isUser) {
            Write-Host "  -> Would download: $($item.url)"
        }
    }
} else {
    Write-Host "Failed to fetch queue or empty queue"
}
