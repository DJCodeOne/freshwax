# ============================================================================
#  relay-secrets.example.ps1  —  TEMPLATE.
#  Copy to relay-secrets.ps1 (next to butt-multistream.ps1 on the host) and fill
#  in the real values. relay-secrets.ps1 is gitignored — NEVER commit it.
#  Dot-sourced via  . "$PSScriptRoot\relay-secrets.ps1"  by butt-multistream.ps1.
# ============================================================================
$FW_TWITCH  = 'rtmp://live.twitch.tv/live/YOUR_FRESHWAX_TWITCH_STREAM_KEY'
$FW_YOUTUBE = 'rtmp://a.rtmp.youtube.com/live2/YOUR_FRESHWAX_YOUTUBE_STREAM_KEY'
$SERVER_KEY = 'YOUR_STREAM_SERVER_KEY'
