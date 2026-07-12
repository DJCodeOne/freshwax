# ============================================================================
#  multistream-relay.ps1  —  Unified FreshWax multistream controller
# ----------------------------------------------------------------------------
#  Replaces start-twitch-relay.bat + stop-twitch-relay.bat + start-placeholder-
#  relay.bat + butt-multistream.ps1 with ONE polling controller. No MediaMTX
#  runOnReady hooks needed (so no recursion games), and OBS + BUTT share one
#  code path.
#
#  Every ~4s it figures out the source and converges the relay to match:
#    - OBS  : an fwx_* path is publishing to MediaMTX  -> Quick Sync consolidate
#             that stream into freshwax-main.
#    - BUTT : Icecast /live is up AND a placeholder/audio DJ is live -> Quick
#             Sync composite (branded placeholder video + Icecast audio) into
#             freshwax-main.
#    - then : stream-COPY freshwax-main -> FW Twitch / YouTube / DJ's Twitch.
#
#  Reliability (the point of the rewrite):
#    * Auto-reconnect — the poll loop restarts ANY producer/relay ffmpeg that
#      has died, so a momentary network blip to a platform self-heals.
#    * Readiness-gated — waits for freshwax-main to actually be ready on the
#      MediaMTX API before starting the copies (no fixed-sleep races).
#    * Precise stop — tracks only the PIDs it spawns; never touches the
#      always-on icecast-bridge ffmpeg (website audio).
#    * Encoder fallback — probes Quick Sync once; falls back to libx264.
#    * loudnorm — one audio normalise on the single encode, so every platform
#      goes out at a consistent ~-14 LUFS.
#
#  NOT ENABLED automatically. Run:  pwsh -File C:\mediamtx\multistream-relay.ps1
#  (or install as NSSM service — see MULTISTREAM-README.md)
# ============================================================================

$ErrorActionPreference = 'Continue'

# --- Config -----------------------------------------------------------------
$FFMPEG      = 'C:\ffmpeg\bin\ffmpeg.exe'
$PLACEHOLDER = 'C:\mediamtx\placeholder-bg.mp4'
$BUG         = 'C:\mediamtx\freshwax-bug.png'   # top-right FreshWax bug baked into freshwax-main
$ICECAST     = 'http://localhost:8000/live'
$LOCAL_MAIN  = 'rtmp://localhost:1935/live/freshwax-main'
$MTX_API     = 'http://localhost:9997/v3/paths/list'
$STATUS_API  = 'https://freshwax.co.uk/api/livestream/status/?fresh=1'
$DJKEY_API   = 'https://freshwax.co.uk/api/livestream/dj-twitch-key?current=1'
$YTID_API    = 'https://freshwax.co.uk/api/livestream/youtube-live-id'

. "$PSScriptRoot\relay-secrets.ps1"   # $FW_TWITCH, $FW_YOUTUBE, $SERVER_KEY

$LOG         = 'C:\mediamtx\multistream-relay.log'
$STATUS_FILE = 'C:\mediamtx\multistream-status.json'
$POLL        = 4          # seconds between convergence ticks
$LOUDNORM    = 'loudnorm=I=-14:LRA=11:TP=-1'

function Log($msg) {
  Add-Content -Path $LOG -Value ("{0} - {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# --- One-time Quick Sync probe (fall back to libx264) -----------------------
function Select-Encoder {
  try {
    & $FFMPEG -hide_banner -loglevel error -f lavfi -i 'testsrc=size=640x360:rate=30' `
      -t 1 -c:v h264_qsv -f null - 2>$null
    if ($LASTEXITCODE -eq 0) { return 'h264_qsv' }
  } catch {}
  Log 'Quick Sync (h264_qsv) unavailable — falling back to libx264'
  return 'libx264'
}
$ENCODER = Select-Encoder
Log "Encoder: $ENCODER"

# --- State ------------------------------------------------------------------
$script:producerPid = $null      # ffmpeg producing freshwax-main
$script:producerKind = $null     # 'obs' | 'butt'
$script:fanout = @{}             # name -> @{ pid; url }
$script:djKey = $null
$script:ytFetched = $false
$script:ytStoppedAt = $null      # set by Stop-All; gates the YouTube cool-off
$script:ytCooloffLogged = $false

function Start-Ff([string[]]$ffargs, [string]$logfile) {
  (Start-Process -FilePath $FFMPEG -ArgumentList $ffargs -WindowStyle Hidden -PassThru -RedirectStandardError $logfile).Id
}
function Alive($procId) { $procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue) }

# --- MediaMTX path queries --------------------------------------------------
function Get-ReadyPaths {
  try { return (Invoke-RestMethod -Uri $MTX_API -TimeoutSec 4).items | Where-Object { $_.ready } }
  catch { return @() }
}
function MainReady { @(Get-ReadyPaths | Where-Object { $_.name -eq 'live/freshwax-main' }).Count -gt 0 }
function Get-ObsPath { @(Get-ReadyPaths | Where-Object { $_.name -match '^live/fwx_' } | Select-Object -First 1).name }

# --- Source detection -------------------------------------------------------
function Test-Icecast {
  # BUTT audio is flowing iff the icecast-bridge has 'icecast-live' ready on
  # MediaMTX. (Icecast returns 400 to a HEAD on a live source mount, so don't
  # probe it directly — use the bridge's readiness as the signal.)
  @(Get-ReadyPaths | Where-Object { $_.name -eq 'icecast-live' }).Count -gt 0
}
function Test-ButtDj {
  try {
    $p = (Invoke-RestMethod -Uri $STATUS_API -TimeoutSec 6).primaryStream
    if (-not $p) { return $false }
    if ($p.isRelay) { return $false }                    # relaying another station in
    if ($p.broadcastMode -eq 'video') { return $false }  # OBS path
    return $true                                          # placeholder/audio = BUTT
  } catch { $false }
}
function Get-Source {
  $obs = Get-ObsPath
  if ($obs) { return @{ kind = 'obs'; path = $obs } }
  if ((Test-Icecast) -and (Test-ButtDj)) { return @{ kind = 'butt' } }
  return @{ kind = 'none' }
}

# --- DJ personal Twitch key (current live DJ) -------------------------------
function Get-DjKey {
  try {
    $r = Invoke-RestMethod -Uri $DJKEY_API -Headers @{ 'x-server-key' = $SERVER_KEY } -TimeoutSec 12
    if ($r.djTwitchKey -and $r.djTwitchKey -ne 'null') { return $r.djTwitchKey }
  } catch { Log "DJ key fetch failed: $($_.Exception.Message)" }
  return $null
}

# --- Producer: source -> freshwax-main (one Quick Sync encode + loudnorm) ---
function Start-Producer($src) {
  $venc = @('-c:v', $ENCODER, '-b:v','4000k','-maxrate','6000k','-bufsize','8000k','-g','60')
  if ($ENCODER -eq 'h264_qsv') { $venc += @('-pix_fmt','nv12') } else { $venc += @('-preset','veryfast','-pix_fmt','yuv420p') }

  # The FreshWax bug (freshwax-bug.png) is overlaid top-right and baked into
  # freshwax-main, so it shows on Twitch/YouTube for BOTH source types. The
  # website paints its own overlay, so it never doubles up there.
  if ($src.kind -eq 'obs') {
    $in = "rtmp://localhost:1935/$($src.path)"
    $a = @('-hide_banner','-loglevel','warning','-i',$in,'-i',$BUG,
           '-filter_complex',"[0:v]fade=t=in:st=0:d=2[fg];[fg][1:v]overlay=W-w-16:16[v];[0:a]$LOUDNORM[a]",
           '-map','[v]','-map','[a]') + $venc +
         @('-c:a','aac','-b:a','192k','-ar','44100','-fps_mode','cfr','-f','flv',$LOCAL_MAIN)
  } else {
    # Icecast input needs reconnect flags: on a BUTT drop the HTTP stream EOFs and
    # ffmpeg otherwise keeps encoding the looped video with NO audio (silent zombie
    # — path stays "ready" so the controller never restarts it). rw_timeout catches
    # hung sockets (CGNAT teardown) that never EOF.
    $a = @('-hide_banner','-loglevel','warning','-stream_loop','-1','-re','-i',$PLACEHOLDER,
           '-thread_queue_size','1024',
           '-reconnect','1','-reconnect_at_eof','1','-reconnect_streamed','1',
           '-reconnect_on_http_error','4xx,5xx','-reconnect_delay_max','5',
           '-rw_timeout','15000000','-i',$ICECAST,'-i',$BUG,
           '-filter_complex',"[0:v][2:v]overlay=W-w-16:16[v];[1:a]aresample=async=1,$LOUDNORM[a]",
           '-map','[v]','-map','[a]') + $venc +
         @('-c:a','aac','-b:a','192k','-ar','44100','-ac','2','-fps_mode','cfr','-f','flv',$LOCAL_MAIN)
  }
  $script:producerPid  = Start-Ff $a 'C:\mediamtx\relay-main.log'
  $script:producerKind = $src.kind
  Log "Producer started ($($src.kind), pid $script:producerPid)"
}

# --- Fan-out: freshwax-main -> each platform, restart any that died ---------
function Converge-Fanout {
  $targets = @{ twitch = $FW_TWITCH; youtube = $FW_YOUTUBE }
  if ($script:djKey) { $targets['dj-twitch'] = "rtmp://live.twitch.tv/live/$script:djKey" }

  foreach ($name in $targets.Keys) {
    # YouTube cool-off: a quick same-key reconnect re-attaches YouTube's stale ingest
    # session and the waiting broadcast never binds (stuck "Preparing stream", validated
    # Jul 12 2026 — a ~10s gap was not enough, ~100s was). Hold the YouTube relay for
    # 2 min after a teardown so the next arrival registers as a fresh stream. Twitch
    # needs no such gap, and mid-stream ffmpeg crash-restarts are unaffected (the
    # cool-off is armed only by Stop-All).
    if ($name -eq 'youtube' -and $script:ytStoppedAt) {
      $since = ((Get-Date) - $script:ytStoppedAt).TotalSeconds
      if ($since -lt 120) {
        if (-not $script:ytCooloffLogged) {
          Log ("YouTube cool-off: holding relay for {0}s so the ingest session expires" -f [int](120 - $since))
          $script:ytCooloffLogged = $true
        }
        continue
      }
      $script:ytStoppedAt = $null; $script:ytCooloffLogged = $false
    }
    $cur = $script:fanout[$name]
    if (-not ($cur -and (Alive $cur.pid))) {
      if ($cur) { Log "Relay '$name' died — restarting" }
      $newPid = Start-Ff @('-hide_banner','-loglevel','warning','-i',$LOCAL_MAIN,'-c','copy','-f','flv',$targets[$name]) "C:\mediamtx\relay-$name.log"
      $script:fanout[$name] = @{ pid = $newPid; url = $targets[$name] }
      Log "Relay '$name' started (pid $newPid)"
    }
  }
  # Drop a DJ relay if the key went away
  if (-not $script:djKey -and $script:fanout.ContainsKey('dj-twitch')) {
    try { Stop-Process -Id $script:fanout['dj-twitch'].pid -Force -ErrorAction SilentlyContinue } catch {}
    $script:fanout.Remove('dj-twitch')
  }
}

function Stop-All {
  if ($script:producerPid) { try { Stop-Process -Id $script:producerPid -Force -ErrorAction SilentlyContinue } catch {} }
  foreach ($v in $script:fanout.Values) { try { Stop-Process -Id $v.pid -Force -ErrorAction SilentlyContinue } catch {} }
  $script:producerPid = $null; $script:producerKind = $null
  $script:fanout = @{}; $script:djKey = $null; $script:ytFetched = $false
  $script:ytStoppedAt = Get-Date; $script:ytCooloffLogged = $false
  Remove-Item $STATUS_FILE -ErrorAction SilentlyContinue
  Log 'Stopped all relays'
}

function Write-Status($src) {
  $obj = @{
    source    = $src
    encoder   = $ENCODER
    main      = [bool](Alive $script:producerPid)
    twitch    = [bool]($script:fanout['twitch']    -and (Alive $script:fanout['twitch'].pid))
    youtube   = [bool]($script:fanout['youtube']   -and (Alive $script:fanout['youtube'].pid))
    djTwitch  = [bool]($script:fanout['dj-twitch'] -and (Alive $script:fanout['dj-twitch'].pid))
    updated   = (Get-Date -Format 'o')
  }
  try { $obj | ConvertTo-Json -Compress | Set-Content -Path $STATUS_FILE -Encoding utf8 } catch {}
}

# --- Main convergence loop --------------------------------------------------
Log 'Multistream controller started'
while ($true) {
  $src = Get-Source

  if ($src.kind -eq 'none') {
    if ($script:producerPid -or $script:fanout.Count) { Stop-All }
  }
  else {
    # 1) Producer up?  (also handles a crashed producer or a source switch)
    if (-not (Alive $script:producerPid) -or $script:producerKind -ne $src.kind) {
      if ($script:producerPid -or $script:fanout.Count) { Stop-All }
      Start-Producer $src
    }
    # 2) Once freshwax-main is actually ready, fetch the DJ key (once) + fan out
    elseif (MainReady) {
      if ($null -eq $script:djKey) { $script:djKey = Get-DjKey }
      Converge-Fanout
      # 3) YouTube live-id fetch (once, header-authed — the old scripts forgot the header)
      if (-not $script:ytFetched -and $script:fanout['youtube'] -and (Alive $script:fanout['youtube'].pid)) {
        try {
          Invoke-RestMethod -Uri $YTID_API -Method Post -Headers @{ 'x-server-key' = $SERVER_KEY } `
            -ContentType 'application/json' -Body '{"streamKey":"live/freshwax-main"}' -TimeoutSec 15 | Out-Null
          $script:ytFetched = $true
        } catch { Log "YouTube live-id fetch failed: $($_.Exception.Message)" }
      }
    }
  }

  Write-Status $src.kind
  Start-Sleep -Seconds $POLL
}
