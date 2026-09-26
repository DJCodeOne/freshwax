# FreshWax Daily Backup Script
# Backs up to F: (USB) and E: (internal) drives
# Keeps the last 7 daily backups + the first backup of each month on each drive

$timestamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$source = "C:\Users\Owner\freshwax"
$logFile = "C:\Users\Owner\freshwax\scripts\backup.log"
$nodeExe = "C:\Program Files\nodejs\node.exe"

# Log function
function Log($msg) {
    $logMsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg"
    Write-Host $logMsg
    Add-Content -Path $logFile -Value $logMsg
}

# Delete all but the last 7 daily backups + the first backup of each month.
# Deletes via cmd rd with \\?\ paths so reserved-name files (e.g. "nul") can't block removal.
function Prune-Backups($dest) {
    $dirs = Get-ChildItem $dest -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^freshwax-\d{4}-\d{2}-\d{2}-\d{4}$' } | Sort-Object Name
    if (-not $dirs -or @($dirs).Count -le 7) { return }
    $keepLast = $dirs | Select-Object -Last 7
    $monthlyFirst = $dirs | Group-Object { $_.Name.Substring(9, 7) } | ForEach-Object { ($_.Group | Sort-Object Name)[0] }
    $keepNames = @($keepLast.Name) + @($monthlyFirst.Name) | Sort-Object -Unique
    foreach ($d in $dirs) {
        if ($keepNames -notcontains $d.Name) {
            cmd /c rd /s /q "\\?\$($d.FullName)" 2>&1 | Out-Null
            if (Test-Path -LiteralPath $d.FullName) {
                Log "WARNING: could not prune $($d.FullName)"
            } else {
                Log "Pruned old backup: $($d.FullName)"
            }
        }
    }
}

# Copy the streaming-host configs + secrets that live OUTSIDE the repo (mediamtx,
# icecast, cloudflared tunnel creds, NSSM service defs, pm2 dump) into the backup,
# so one backup folder is enough to rebuild the machine. Big re-downloadable
# binaries (ffmpeg, cloudflared.exe) and placeholder-bg.mp4 (in ..\host-static,
# copied once) are excluded - see host-configs\README.txt in each backup.
function Backup-HostConfigs($dest) {
    $hc = Join-Path $dest "host-configs"
    robocopy "C:\mediamtx" "$hc\mediamtx" *.yml *.ps1 *.bat *.cjs *.js *.json *.md *.png *.jpg /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    robocopy "C:\icecast" "$hc\icecast" *.xml *.js *.ps1 *.bat *.png /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    robocopy "C:\cloudflared" "$hc\cloudflared" config.yml /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    robocopy "C:\Users\Owner\.cloudflared" "$hc\dot-cloudflared" *.json *.pem *.yml /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    New-Item -ItemType Directory -Path "$hc\nssm-services" -Force | Out-Null
    foreach ($svc in 'FreshWax-MediaMTX','FreshWax-Icecast','FreshWax-Cloudflared','FreshWax-Multistream','FreshWax-ButtRelay','FreshWax-AudioProcessor') {
        reg export "HKLM\SYSTEM\CurrentControlSet\Services\$svc" "$hc\nssm-services\$svc.reg" /y 2>&1 | Out-Null
    }
    New-Item -ItemType Directory -Path "$hc\pm2" -Force | Out-Null
    Copy-Item "C:\Users\Owner\.pm2\dump.pm2" "$hc\pm2\dump.pm2" -ErrorAction SilentlyContinue
    Copy-Item "C:\Users\Owner\install-streaming-services.bat" "$hc\" -ErrorAction SilentlyContinue
    @"
Rebuild notes (streaming host)
==============================
- mediamtx\        -> C:\mediamtx   (re-download ffmpeg.exe + ffprobe.exe into C:\mediamtx;
                     placeholder-bg.mp4 is in ..\..\host-static, or re-encode the site's stream-bg.webm to 720p30 H.264)
- icecast\         -> C:\icecast    (install Icecast to 'C:\Program Files (x86)\Icecast' first)
- cloudflared\     -> C:\cloudflared   (re-download cloudflared.exe)
- dot-cloudflared\ -> C:\Users\Owner\.cloudflared   (tunnel credentials + cert)
- nssm-services\   -> NSSM service definitions for reference; reinstall via host-configs\install-streaming-services.bat,
                     repo scripts\install-audio-processor-service.bat, C:\icecast\install-butt-relay.bat,
                     C:\mediamtx\install-multistream-service.bat (all run as administrator; nssm.exe from nssm.cc)
- pm2\dump.pm2     -> C:\Users\Owner\.pm2\ then 'pm2 resurrect' (playlist-server + audio-relay)
- The repo copy next to this folder has .env (Firebase/R2/admin secrets) and wrangler.toml.
"@ | Set-Content "$hc\README.txt"
    Log "Host configs copied to $hc"
}

Log "=== Starting FreshWax Backup ==="

# Backup to F: (USB drive)
if (Test-Path "F:\") {
    $destF = "F:\FreshWax-Backups\freshwax-$timestamp"
    Log "Backing up to F: drive: $destF"
    robocopy $source $destF /MIR /XD node_modules .git dist .astro .wrangler /XF *.log nul /NFL /NDL /NJH /NJS /R:1 /W:1
    Log "F: drive backup complete"
    Backup-HostConfigs $destF
    Prune-Backups "F:\FreshWax-Backups"
} else {
    Log "WARNING: F: drive not available - skipping USB backup"
}

# Backup to E: (internal drive)
if (Test-Path "E:\") {
    $destE = "E:\FreshWax-Backups\freshwax-$timestamp"
    Log "Backing up to E: drive: $destE"
    robocopy $source $destE /MIR /XD node_modules .git dist .astro .wrangler /XF *.log nul /NFL /NDL /NJH /NJS /R:1 /W:1
    Log "E: drive backup complete"
    Backup-HostConfigs $destE
    Prune-Backups "E:\FreshWax-Backups"
} else {
    Log "WARNING: E: drive not available - skipping internal backup"
}

# Backup Firebase data
Log "Starting Firebase data backup..."
if (-not (Test-Path $nodeExe)) { $nodeExe = "node" }
$firebaseResult = & $nodeExe "$source\scripts\backup-firebase.cjs" 2>&1
if ($LASTEXITCODE -ne 0) {
    Log "Firebase backup FAILED (exit $LASTEXITCODE): $(($firebaseResult | Select-Object -Last 5) -join ' | ')"
} else {
    Log "Firebase backup complete: $(($firebaseResult | Where-Object { $_ -match 'Total:|Saved:|Size:|error|failed' }) -join ' | ')"
}

# Encrypted cloud copy -> Google Drive (rclone crypt remote "gcrypt", client-side AES;
# keys in C:\Users\Owner\freshwax-cloud-backup-KEYS.txt - keep an offline copy!)
$rclone = "C:\Users\Owner\tools\rclone.exe"
$rcloneConf = "C:\Users\Owner\tools\rclone.conf"
if ((Test-Path $rclone) -and (Test-Path $rcloneConf)) {
    $srcDir = if (Test-Path "E:\FreshWax-Backups\freshwax-$timestamp") { "E:\FreshWax-Backups\freshwax-$timestamp" }
              elseif (Test-Path "F:\FreshWax-Backups\freshwax-$timestamp") { "F:\FreshWax-Backups\freshwax-$timestamp" }
              else { $null }
    if ($srcDir) {
        Log "Starting cloud backup to Google Drive..."
        $zip = Join-Path $env:TEMP "freshwax-backup-$timestamp.zip"
        try {
            $tarArgs = @('-a', '-cf', $zip, '-C', $srcDir, '.')
            $fbJson = "E:\FreshWax-Backups\firebase-data\firebase-backup-$(Get-Date -Format 'yyyy-MM-dd').json"
            if (Test-Path $fbJson) { $tarArgs += @('-C', (Split-Path $fbJson), (Split-Path $fbJson -Leaf)) }
            & "$env:SystemRoot\System32\tar.exe" @tarArgs 2>&1 | Out-Null
            & $rclone copyto $zip "gcrypt:freshwax-backup-$timestamp.zip" --config $rcloneConf 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Log "Cloud backup FAILED (rclone exit $LASTEXITCODE)"
            } else {
                Log "Cloud backup uploaded: freshwax-backup-$timestamp.zip ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)"
                # Prune cloud copies: keep last 7 + the first of each month (same policy as the drives)
                $names = @(& $rclone lsf "gcrypt:" --config $rcloneConf 2>$null) |
                    Where-Object { $_ -match '^freshwax-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$' } | Sort-Object
                if ($names.Count -gt 7) {
                    $keepLast = $names | Select-Object -Last 7
                    $monthlyFirst = $names | Group-Object { $_.Substring(16, 7) } | ForEach-Object { ($_.Group | Sort-Object)[0] }
                    $keepNames = @($keepLast) + @($monthlyFirst) | Sort-Object -Unique
                    foreach ($n in $names) {
                        if ($keepNames -notcontains $n) {
                            & $rclone deletefile "gcrypt:$n" --config $rcloneConf 2>&1 | Out-Null
                            Log "Pruned cloud backup: $n"
                        }
                    }
                }
            }
        } finally {
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
        }
    } else {
        Log "WARNING: no local backup folder found for cloud upload"
    }
} else {
    Log "WARNING: rclone not configured - skipping cloud backup"
}

Log "=== Backup Complete ==="
