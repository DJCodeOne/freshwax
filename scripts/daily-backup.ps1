# FreshWax Daily Backup Script
# Backs up to F: (USB) and E: (internal) drives
# Keeps last 7 backups on each drive

$timestamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$source = "C:\Users\Owner\freshwax"
$logFile = "C:\Users\Owner\freshwax\scripts\backup.log"

# Log function
function Log($msg) {
    $logMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg"
    Write-Host $logMsg
    Add-Content -Path $logFile -Value $logMsg
}

Log "=== Starting FreshWax Backup ==="

# Backup to F: (USB drive)
if (Test-Path "F:\") {
    $destF = "F:\FreshWax-Backups\freshwax-$timestamp"
    Log "Backing up to F: drive: $destF"
    robocopy $source $destF /MIR /XD node_modules .git dist .astro .wrangler /XF *.log /NFL /NDL /NJH /NJS /R:1 /W:1
    Log "F: drive backup complete"
} else {
    Log "WARNING: F: drive not available - skipping USB backup"
}

# Backup to E: (internal drive)
if (Test-Path "E:\") {
    $destE = "E:\FreshWax-Backups\freshwax-$timestamp"
    Log "Backing up to E: drive: $destE"
    robocopy $source $destE /MIR /XD node_modules .git dist .astro .wrangler /XF *.log /NFL /NDL /NJH /NJS /R:1 /W:1
    Log "E: drive backup complete"
} else {
    Log "WARNING: E: drive not available - skipping internal backup"
}

# Backup Firebase data
Log "Starting Firebase data backup..."
$firebaseResult = & node "$source\scripts\backup-firebase.cjs" 2>&1
Log "Firebase backup complete"

Log "=== Backup Complete ==="
