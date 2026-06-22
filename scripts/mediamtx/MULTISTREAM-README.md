# FreshWax multistreaming — Twitch + YouTube

**Status: LIVE.** Runs as the `FreshWax-Multistream` NSSM service (auto-start).
Validated end-to-end Jun 2026 on both platforms. Host: i7-6700K + Intel HD 530
(Quick Sync) on 60 Mbps up (needs ~12–18 for the three outbound streams).

These are the **tracked copies** of scripts that run from `C:\mediamtx\` on the
streaming host. Edit here, then redeploy to the host (copy the files across).

## How it works — one controller
`multistream-relay.ps1` is a single polling controller. Every ~4s it detects the
source and converges the relay:
- **OBS** — an `fwx_*` path is publishing to MediaMTX (seen via the API on
  `:9997/v3/paths/list`) → Quick Sync **consolidate** it into `freshwax-main`.
- **BUTT/audio** — the `icecast-live` path is ready on MediaMTX (i.e. BUTT audio
  is flowing through the bridge) AND the status API shows a placeholder/audio DJ
  → Quick Sync **composite** (branded placeholder video + Icecast audio) into
  `freshwax-main`.
- then **stream-copies** `freshwax-main` → Fresh Wax Twitch / YouTube / the DJ's
  personal Twitch.

It encodes **once** (h264_qsv — works even as a session-0 service; falls back to
libx264 if QSV is ever unavailable) and copies to every platform. The **FreshWax
bug** (`freshwax-bug.png`) is overlaid top-right and baked into `freshwax-main`,
so it shows on Twitch/YouTube for **both** OBS and BUTT. (The website paints its
own DOM overlay, so it never doubles up there.)

Built-in reliability: **auto-reconnect** (the poll loop restarts any dead
producer/relay ffmpeg), **readiness-gated** fan-out (waits for `freshwax-main` on
`:9997`), **precise stop** (only its own PIDs — never the always-on
`icecast-bridge`), **loudnorm** ~-14 LUFS on the single encode. Writes
`multistream-status.json` each tick (hook for surfacing relay health in the lobby).

## Files
- `multistream-relay.ps1` — the controller (the only relay script that runs)
- `install-multistream-service.bat` — installs/updates the NSSM service (run as admin)
- `freshwax-bug.png` — the top-right FRESH·WAX bug baked into the stream
- `icecast-bridge.bat` — unrelated: Icecast→HLS for website listeners (always on)
- `relay-secrets.example.ps1` — template; copy to `relay-secrets.ps1` on the host (gitignored)
- On the host only (gitignored / not in repo): `relay-secrets.ps1` (real keys),
  `placeholder-bg.mp4` (regenerable from the site's `stream-bg.webm`), `*.log`

## Install / update the service
Right-click **`install-multistream-service.bat` → Run as administrator** (service
installs need elevation). Re-runnable: it hands over from any standalone
controller (brief ~10–15s Twitch/YouTube blip) then installs + starts the service.
Manual control: `nssm start|stop|restart FreshWax-Multistream`.

## Secrets
`relay-secrets.ps1` (host, gitignored) holds the Twitch/YouTube stream-key URLs +
`$SERVER_KEY`. The Cloudflare Pages secret **`STREAM_SERVER_KEY` must equal
`$SERVER_KEY`** — it authes the `dj-twitch-key` + `youtube-live-id` endpoints
(set via `wrangler pages secret put STREAM_SERVER_KEY --project-name freshwax`).
If keys rotate, update both places.

## YouTube gotcha (important)
YouTube **auto-start** only fires when the stream *arrives* at a broadcast that's
in the "waiting" state. A stream already pumping (or one that crash-looped) leaves
the broadcast stuck on **"Preparing stream"** with no GO LIVE button. Fix: end the
stuck broadcast → **Create → Go Live** fresh (auto-start ON, reuse the FreshWaxLive
key) → the relay's arrival trips auto-start. `youtube-live-id` then returns the
video ID so the site can link it.

## Known follow-ups (small)
- Back off relays that fail repeatedly (retry ~30s instead of every 4s).
- `youtube-live-id` fetch: retry until it returns a real video ID (currently stops
  on the first "not live yet" response).
- Wire `multistream-status.json` into the DJ-lobby Twitch/YouTube indicators.
