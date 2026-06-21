# BUTT / audio-only multistreaming to Twitch + YouTube

**Status: BUILT, NOT ENABLED.** Turn it on only when the host has a solid wired
router connection (multistreaming pushes 3+ outbound RTMP streams).

## What it does
When a DJ goes live via **BUTT** (audio only), the website already shows a
branded placeholder video + the Icecast audio. Twitch/YouTube need a real video
track, so `butt-multistream.ps1` composites the **same placeholder video** (the
site's animated background) with the live Icecast audio and pushes it to:

- `rtmp://localhost:1935/live/freshwax-main`  → website + radio-station relays
- Fresh Wax **Twitch**
- Fresh Wax **YouTube**
- the **DJ's personal Twitch** (if they entered a key in the DJ lobby)

## How it's efficient (no GPU needed)
It encodes the video **once** with **Intel Quick Sync** (`h264_qsv`, the i7-6700K's
HD 530 iGPU) to `freshwax-main`, then **stream-copies** that to Twitch/YouTube/DJ
(`-c copy`, zero re-encode). So it's one light hardware encode + copies — the CPU
stays mostly idle. A discrete GPU (e.g. GTX 780) is not needed.

## The placeholder video
`C:\mediamtx\placeholder-bg.mp4` — the site's `stream-bg.webm` background
(already carries the Fresh Wax logo) re-encoded to 720p H.264, 30fps. Loops.
To regenerate after the site bg changes:
```
ffmpeg -y -i <stream-bg.webm> -an -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30" -c:v h264_qsv -b:v 3000k -maxrate 3500k -bufsize 7000k -g 60 -pix_fmt nv12 C:\mediamtx\placeholder-bg.mp4
```
Fallback static branded image (if ever needed): `C:\icecast\freshwax-audio-placeholder.png`.

## How the trigger works
BUTT publishes to **Icecast**, not MediaMTX, so nothing in `mediamtx.yml` fires
for it (that's why the old `butt-stream` runOnReady was a no-op). Instead
`butt-multistream.ps1` is a small controller loop that every 5s checks:
1. Icecast `/live` is up (200), AND
2. the freshwax status API shows a DJ live in placeholder/audio mode (not OBS,
   not a relay-in).
When both are true it starts the relay; when not, it stops it. It tracks only
the ffmpeg PIDs it spawned, so stopping never kills the always-on
`icecast-bridge` ffmpeg that feeds the website's HLS.

## To ENABLE
1. Make sure the host is on a **wired** connection with solid upload.
2. Run it once to test with a live BUTT stream:
   ```
   pwsh -File C:\mediamtx\butt-multistream.ps1
   ```
   Watch `C:\mediamtx\butt-multistream.log` and the per-output logs
   (`butt-main.log`, `butt-twitch.log`, `butt-youtube.log`). Confirm the stream
   appears on Twitch/YouTube and A/V stays in sync.
3. To run it permanently, install as an NSSM service (mirrors the other
   FreshWax services):
   ```
   nssm install FreshWax-ButtMultistream "C:\Program Files\PowerShell\7\pwsh.exe" "-File C:\mediamtx\butt-multistream.ps1"
   nssm set FreshWax-ButtMultistream Start SERVICE_AUTO_START
   nssm start FreshWax-ButtMultistream
   ```
   (Use `powershell.exe` instead of `pwsh.exe` if PowerShell 7 isn't installed.)

## OBS multistreaming (separate path — also Quick Sync now, disabled)
OBS streams publish to MediaMTX, so they use `start-twitch-relay.bat` via the
`runOnReady` hook in `mediamtx.yml` (currently commented out). To enable, uncomment
the `runOnReady`/`runOnNotReady` lines (~line 106) and restart `FreshWax-MediaMTX`.

`start-twitch-relay.bat` now uses the **same Quick Sync, encode-once design** as
the BUTT path (rewritten Jun 2026; original saved as `.bak`):
- Encodes the OBS stream **once** via `h264_qsv` into `freshwax-main` (normalises
  bitrate/keyframes for Twitch's limit + 2s fade-in from black), then **stream-copies**
  freshwax-main to FW Twitch / YouTube / DJ's Twitch. Replaces the old two 6Mbps
  **libx264** re-encodes with one hardware encode.
- **Recursion guard:** pathDefaults `runOnReady` fires for *every* path including
  the freshwax-main we publish ourselves — the script exits immediately when
  invoked with `freshwax-main` (or any non-`fwx_` path) so there's no double fan-out.
- Sends the server key as the `x-server-key` **header** (the endpoint rejects
  query-param keys — the old script used a query param and would have 403'd).

## First-run things to verify (only testable while live)
- **A/V sync** over a long set (looping video + live audio). If it drifts, tune
  the `-af aresample=async=1` / add `-vsync` in `butt-multistream.ps1`.
- **Bitrate headroom** on the actual router/upload before going live for real.
- The Fresh Wax Twitch/YouTube **stream keys** in this script + the .bat are
  hard-coded; update them here if they're ever rotated.
