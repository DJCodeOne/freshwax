# FreshWax multistreaming — Twitch + YouTube (+ DJ's own Twitch)

**Status: BUILT, NOT ENABLED.** Turn on only after the pre-enable test below.
Upload need is ~12–18 Mbps (three platforms); the host has 60 Mbps up — fine.

## One controller does everything
`multistream-relay.ps1` is a single polling controller that replaces the old
per-path scripts (`start-twitch-relay.bat`, `stop-twitch-relay.bat`,
`start-placeholder-relay.bat`, `butt-multistream.ps1` — kept for reference but
**superseded**). No MediaMTX `runOnReady` hooks are needed anymore.

Every ~4s it detects the source and converges the relay to match:
- **OBS** — an `fwx_*` path is publishing to MediaMTX → Quick Sync **consolidate**
  it into `freshwax-main`.
- **BUTT** — Icecast `/live` is up AND a placeholder/audio DJ is live → Quick
  Sync **composite** (branded placeholder video + Icecast audio) into `freshwax-main`.
- then **stream-copies** `freshwax-main` → Fresh Wax Twitch / YouTube / DJ's Twitch.

It encodes the video **once** (Intel Quick Sync, the i7-6700K's HD 530) and copies
to every platform — one light hardware encode, no discrete GPU needed.

### What the rewrite fixed (vs the old .bat/.ps1 scripts)
- **Auto-reconnect** — the poll loop restarts any producer/relay ffmpeg that dies,
  so a momentary blip to a platform self-heals (the old scripts were fire-and-forget
  and would drop a platform for the rest of the set).
- **Readiness-gated** — waits for `freshwax-main` to actually be ready on the
  MediaMTX API (`:9997`) before starting the copies (no fixed-sleep races).
- **Precise stop** — kills only the PIDs it spawned; never the always-on
  `icecast-bridge` (so website audio never gaps).
- **Encoder fallback** — probes Quick Sync at startup; falls back to libx264.
- **Loudness** — one `loudnorm` (≈-14 LUFS) on the single encode, so every
  platform goes out at a consistent level.
- **YouTube live-id** — sends the `x-server-key` header the endpoint requires
  (the old scripts omitted it → silent 403, so the site never got the video ID).

## Files (on the host, `C:\mediamtx\`)
- `multistream-relay.ps1` — the controller (this is the only relay script you run)
- `placeholder-bg.mp4` — branded 720p loop (site background; regenerable from R2)
- `relay-secrets.ps1` — **local, gitignored** Twitch/YouTube/server keys
- `multistream-status.json` — written each tick (source + per-platform up/down);
  the hook for surfacing relay health in the DJ lobby later
- `multistream-relay.log` + `relay-*.log` — per-component logs
- `icecast-bridge.bat` — unchanged, unrelated (Icecast→HLS for website listeners)

## To ENABLE (after testing)
Just run the controller — no `mediamtx.yml` changes needed:
```
pwsh -File C:\mediamtx\multistream-relay.ps1
```
Permanent (NSSM service):
```
nssm install FreshWax-Multistream "C:\Program Files\PowerShell\7\pwsh.exe" "-File C:\mediamtx\multistream-relay.ps1"
nssm set FreshWax-Multistream Start SERVICE_AUTO_START
nssm start FreshWax-Multistream
```

## Pre-enable test plan (do this once, live)
1. **Loopback** — start the controller, go live via OBS *and* (separately) BUTT.
   Watch `multistream-relay.log` + `multistream-status.json`: producer up, then
   twitch/youtube/dj true. Confirm `freshwax-main` plays locally.
2. **Test channels first** — point `relay-secrets.ps1` at a throwaway Twitch/YouTube
   before the real house channels; confirm the stream appears and A/V is in sync.
3. **A/V sync over time** — let a BUTT set run 15+ min; the looping video + live
   audio must stay in sync. If it drifts, tighten `aresample=async=1` / add
   `-vsync` in `Start-Producer` (BUTT branch).
4. **Reconnect** — kill one `relay-twitch.log` ffmpeg by PID mid-stream; within
   ~4s the controller should restart it (check the log says "died — restarting").
5. **CPU/upload** — watch Task Manager: one QSV encode + copies should sit light;
   upstream ~12–18 Mbps.

## Notes
- **Secrets** live only in `relay-secrets.ps1` (gitignored). If the Twitch/YouTube
  stream keys or the server key are rotated, update them there — one place.
- **Placeholder loop**: the site background opens with a 2s fade-from-black, so each
  ~5:40 loop is a soft fade (intentional-looking). To remove it, trim the first
  ~3s of `placeholder-bg.mp4`.
- **One DJ at a time** — the app enforces a single live stream, so OBS and BUTT
  never run together; the controller handles a source switch by stopping cleanly
  and restarting on the new source.
- **Relay health in the lobby** is a follow-up: the lobby already has Twitch/YouTube
  indicators; wiring them needs an endpoint that reads `multistream-status.json`
  (the controller already writes it).
