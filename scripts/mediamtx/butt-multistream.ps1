# ============================================================================
#  butt-multistream.ps1  —  BUTT / audio-only multistream controller
# ----------------------------------------------------------------------------
#  When a DJ goes live via BUTT (audio only), the freshwax website shows a
#  branded placeholder video + the Icecast audio. Twitch and YouTube need a
#  REAL video track, so this script composites the same placeholder video with
#  the live Icecast audio and pushes it out.
#
#  Design (CPU-light, suits the i7-6700K + Intel Quick Sync):
#    1. Encode ONCE: placeholder-bg.mp4 (loop) + Icecast /live  ->  freshwax-main
#       via h264_qsv (hardware encode on the HD 530 iGPU).
#    2. Stream-COPY freshwax-main -> Fresh Wax Twitch / YouTube / DJ's Twitch
#       (no re-encode — ~0 extra CPU).
#
#  Trigger: BUTT publishes to Icecast (not MediaMTX), so nothing in MediaMTX
#  fires. This script polls Icecast + the freshwax status API and starts/stops
#  the relay itself. It tracks the ffmpeg PIDs it spawns so stopping the relay
#  never touches the always-on icecast-bridge ffmpeg.
#
#  NOT ENABLED automatically. To run:  pwsh -File C:\mediamtx\butt-multistream.ps1
#  (or install as an NSSM service — see C:\mediamtx\BUTT-MULTISTREAM-README.md)
# ============================================================================

$ErrorActionPreference = 'Continue'

# --- Config -----------------------------------------------------------------
$FFMPEG      = 'C:\ffmpeg\bin\ffmpeg.exe'
$PLACEHOLDER = 'C:\mediamtx\placeholder-bg.mp4'
$ICECAST     = 'http://localhost:8000/live'
$LOCAL_MAIN  = 'rtmp://localhost:1935/live/freshwax-main'
$STATUS_API  = 'https://freshwax.co.uk/api/livestream/status/?fresh=1'
$DJKEY_API   = 'https://freshwax.co.uk/api/livestream/dj-twitch-key?current=1'
$YTID_API    = 'https://freshwax.co.uk/api/livestream/youtube-live-id'

# Secrets ($FW_TWITCH / $FW_YOUTUBE / $SERVER_KEY) — loaded from the local,
# gitignored file next to this script.
. "$PSScriptRoot\relay-secrets.ps1"

$LOG = 'C:\mediamtx\butt-multistream.log'
$POLL_SECONDS = 5

function Log($msg) {
  $line = "{0} - {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LOG -Value $line
}

# --- State ------------------------------------------------------------------
$script:relayPids = @()    # ffmpeg PIDs we spawned (so we kill only ours)
$script:running   = $false

function Start-Ffmpeg([string[]]$ffargs, [string]$logfile) {
  $p = Start-Process -FilePath $FFMPEG -ArgumentList $ffargs -WindowStyle Hidden -PassThru `
        -RedirectStandardError $logfile
  return $p.Id
}

function Start-Relay {
  Log 'BUTT live detected — starting multistream relay'
  $script:relayPids = @()

  # 1) Composite placeholder video + Icecast audio -> freshwax-main (Quick Sync)
  $mainArgs = @(
    '-hide_banner','-loglevel','warning',
    '-stream_loop','-1','-re','-i',$PLACEHOLDER,
    '-thread_queue_size','1024','-i',$ICECAST,
    '-map','0:v:0','-map','1:a:0',
    '-c:v','h264_qsv','-b:v','3000k','-maxrate','3500k','-bufsize','7000k','-g','60','-pix_fmt','nv12',
    '-c:a','aac','-b:a','192k','-ar','44100','-ac','2','-af','aresample=async=1',
    '-fps_mode','cfr','-f','flv',$LOCAL_MAIN
  )
  $script:relayPids += Start-Ffmpeg $mainArgs 'C:\mediamtx\butt-main.log'

  # Give freshwax-main a few seconds to come up before copying from it
  Start-Sleep -Seconds 5

  # 2) Stream-copy freshwax-main -> Fresh Wax Twitch + YouTube (no re-encode)
  $script:relayPids += Start-Ffmpeg @('-hide_banner','-loglevel','warning','-i',$LOCAL_MAIN,'-c','copy','-f','flv',$FW_TWITCH)  'C:\mediamtx\butt-twitch.log'
  $script:relayPids += Start-Ffmpeg @('-hide_banner','-loglevel','warning','-i',$LOCAL_MAIN,'-c','copy','-f','flv',$FW_YOUTUBE) 'C:\mediamtx\butt-youtube.log'

  # 3) Fetch the YouTube live video ID (best-effort, so the site can link it)
  Start-Sleep -Seconds 8
  try {
    Invoke-RestMethod -Uri $YTID_API -Method Post -ContentType 'application/json' `
      -Body '{"streamKey":"live/freshwax-main"}' -TimeoutSec 15 | Out-Null
  } catch { Log "YouTube live-id fetch failed: $($_.Exception.Message)" }

  # 4) DJ's personal Twitch (current live DJ key, header-authed) — best-effort
  try {
    $dj = Invoke-RestMethod -Uri $DJKEY_API -Headers @{ 'x-server-key' = $SERVER_KEY } -TimeoutSec 15
    if ($dj.djTwitchKey -and $dj.djTwitchKey -ne 'null') {
      $djUrl = "rtmp://live.twitch.tv/live/$($dj.djTwitchKey)"
      $script:relayPids += Start-Ffmpeg @('-hide_banner','-loglevel','warning','-i',$LOCAL_MAIN,'-c','copy','-f','flv',$djUrl) 'C:\mediamtx\butt-twitch-dj.log'
      Log "Relaying to DJ personal Twitch ($($dj.djName))"
    }
  } catch { Log "DJ Twitch key fetch failed: $($_.Exception.Message)" }

  $script:running = $true
  Log ("Relay started (pids: {0})" -f ($script:relayPids -join ','))
}

function Stop-Relay {
  Log 'BUTT offline — stopping multistream relay'
  foreach ($procId in $script:relayPids) {
    try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
  }
  $script:relayPids = @()
  $script:running = $false
  Remove-Item 'C:\mediamtx\current-dj-twitch-key.txt' -ErrorAction SilentlyContinue
}

function Test-IcecastLive {
  try {
    $r = Invoke-WebRequest -Uri $ICECAST -Method Head -TimeoutSec 4 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Test-ButtDjLive {
  # A DJ is live in placeholder/audio (BUTT) mode — NOT OBS (OBS uses the
  # MediaMTX runOnReady path) and NOT a relay-in.
  try {
    $s = Invoke-RestMethod -Uri $STATUS_API -TimeoutSec 6
    if (-not $s.isLive -or -not $s.primaryStream) { return $false }
    $p = $s.primaryStream
    if ($p.isRelay) { return $false }                 # relaying another station in
    if ($p.broadcastMode -eq 'video') { return $false } # OBS video path
    return $true                                       # placeholder/audio = BUTT
  } catch { return $false }
}

# --- Main loop --------------------------------------------------------------
Log 'BUTT multistream controller started'
while ($true) {
  $shouldRun = (Test-IcecastLive) -and (Test-ButtDjLive)

  if ($shouldRun -and -not $script:running) {
    Start-Relay
  } elseif (-not $shouldRun -and $script:running) {
    Stop-Relay
  } elseif ($script:running) {
    # Health check: if the main composite ffmpeg died, restart the whole relay.
    $mainPid = $script:relayPids | Select-Object -First 1
    if ($mainPid -and -not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue)) {
      Log 'Main composite ffmpeg exited unexpectedly — restarting relay'
      Stop-Relay
    }
  }

  Start-Sleep -Seconds $POLL_SECONDS
}
