# YouTube Broadcast Auto-Create — Spec

**Goal**: zero-touch YouTube multistreaming. Today the relay can only push into a
broadcast that already exists; the Fresh Wax channel has **no Default stream key**
(only the custom reusable "FreshWaxLive" key), so YouTube never auto-creates
broadcasts on stream arrival. Someone must open the Studio Go-Live dashboard after
every ended stream to leave a fresh "waiting" broadcast — forget it once and
YouTube is silently absent for the whole slot.

This project gives the relay the ability to **create + bind a broadcast via the
YouTube Data API** right before it starts pushing, with per-DJ titles, and to store
the video ID on the live slot synchronously (killing the Data-API search lag and
the `youtube-live-id` streamKey-mismatch bug in one move).

**Non-goal**: touching the Twitch path, the producer, or the 120s cool-off
(commit `6e164b6f`) — the cool-off stays; it fixes the stale-ingest-session
problem, this spec fixes the missing-broadcast problem. Together = hands-free.

---

## Architecture

One new site endpoint does all YouTube API work (secrets, token refresh, and slot
data already live site-side; the relay already calls site endpoints with
`x-server-key`). The relay gains one HTTP call at a single choke point.

```
DJ goes live (or reconnects after cool-off)
        │
        ▼
multistream-relay.ps1 ── about to start the youtube ffmpeg ──►
        │  POST /api/livestream/youtube-broadcast   (x-server-key)
        │       │
        │       ▼  (Cloudflare Worker)
        │   1. OAuth access token (refresh-token grant, KV-cached ~55 min)
        │   2. ensure-broadcast (idempotent):
        │        live one bound to our key?      → reuse
        │        upcoming one bound to our key?  → reuse (+ retitle)
        │        else liveBroadcasts.insert + bind to FreshWaxLive stream
        │   3. title from the live slot: customTitle > "«DJ» — Live on Fresh Wax"
        │   4. write youtubeLiveId to the LIVE slot (D1 json_set + Firestore
        │      updateDocument — dual store, never setDocument)
        │       │
        │       ▼
        │   returns { videoId, watchUrl, chatUrl, reused }
        ▼
relay starts the youtube ffmpeg → arrival trips enableAutoStart → LIVE
```

Broadcast end is handled by `enableAutoStop`: when ingest stops for good
(controller Stop-All → no data), YouTube completes the broadcast itself. The next
go-live creates the next broadcast. No dashboard visits, ever.

---

## One-time setup (Google Cloud console — operator does this, ~15 min)

1. Same GCP project that holds the existing `YOUTUBE_API_KEY`.
2. **OAuth consent screen**: External. **Publish the app** (leave unverified —
   single internal user; testing mode is unusable because its refresh tokens
   expire after 7 days).
3. **Credentials → OAuth client ID → Web application**:
   redirect URI `https://freshwax.co.uk/api/admin/youtube-oauth/callback`.
4. Scope used: `https://www.googleapis.com/auth/youtube.force-ssl`.
5. Run the one-time consent via the new admin endpoint (below). **At the Google
   account chooser, pick the "Fresh Wax" brand channel, NOT "Code One"** — the
   callback hard-verifies this and refuses tokens for the wrong channel.
6. Copy the displayed refresh token into Pages secrets:
   `wrangler pages secret put YOUTUBE_OAUTH_REFRESH_TOKEN`
   (plus `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`).

Refresh tokens from a published app persist until revoked (password/security
event, or 6 months fully unused — a weekly stream keeps it alive forever).

---

## Components

### 1. `src/lib/youtube-live.ts` (new)

- `getAccessToken(env)` — POST `https://oauth2.googleapis.com/token` with
  `grant_type=refresh_token`; cache in KV (`youtube:access_token`, TTL 3300s).
  Remember `initKVCache(env)` first.
- `ensureBroadcast(env, {title, description})` — the idempotent flow:
  1. `liveStreams.list?part=id,cdn&mine=true` → find item whose
     `cdn.ingestionInfo.streamName` == the FreshWaxLive key (or match by
     `snippet.title == "FreshWaxLive"`); cache the stream **resource id** in KV
     permanently (`youtube:stream_id`) — it is stable.
  2. `liveBroadcasts.list?part=id,status,contentDetails&mine=true&broadcastStatus=active`
     → if one is bound to our stream id, return it (relay crash-restart case).
  3. same with `broadcastStatus=upcoming` → if found, `liveBroadcasts.update`
     the snippet title (dashboard-created ones say "Fresh Wax Live Stream"),
     return it.
  4. else `liveBroadcasts.insert` `part=snippet,contentDetails,status`:
     - `snippet`: title, description, `scheduledStartTime: now`
     - `status`: `privacyStatus: "public"`, `selfDeclaredMadeForKids: false`
     - `contentDetails`: `enableAutoStart: true`, `enableAutoStop: true`,
       `enableDvr: true`, `latencyPreference: "low"`,
       `monitorStream: { enableMonitorStream: false }`  ← required for
       unattended autoStart (monitor stream forces a manual testing phase)
     then `liveBroadcasts.bind?id=<broadcastId>&streamId=<streamId>`.
- All calls: `fetchWithTimeout` + `TIMEOUTS.API`; quota cost is trivial
  (insert 50 + bind 50 + lists ~1-3 per go-live vs 10,000/day budget; also
  eliminates the current 100-unit `search.list` per stream).

### 2. `POST /api/livestream/youtube-broadcast` (new)

- Auth: `x-server-key` timing-safe vs `STREAM_SERVER_KEY` (same as
  `dj-twitch-key`); **add to CSRF_SKIP** in `src/lib/csrf.ts`; rate-limit standard.
- Reads the current live slot (same D1-first source as `status.ts`) →
  title = slot `customTitle ? title : "${djName} — Live on Fresh Wax"`,
  description = short blurb + `https://freshwax.co.uk/live`.
- Calls `ensureBroadcast`, then writes `youtubeLiveId` (+ `youtubeIntegration`
  object as in the old endpoint) onto the live slot:
  - **D1** `livestream_slots`: `json_set` into the `data` blob
  - **Firestore** `livestreamSlots`: `updateDocument` (never `setDocument`)
  - lookup by *currently live slot id*, **not** by streamKey — this replaces the
    broken `streamKey == "live/freshwax-main"` lookup in `youtube-live-id.ts`.
- On any YouTube API failure: log to the admin error log (D1 `error_logs`) so it
  surfaces in `/admin/errors`, return 502 with a terse error.
- Response: `{ success, videoId, watchUrl, chatUrl, reused }`.

### 3. Relay change (`multistream-relay.ps1`, ~15 lines)

In the main loop where the youtube relay is about to be started (cool-off already
satisfied), before `Converge-Fanout` starts the youtube ffmpeg:

```powershell
# $YT_AUTOCREATE comes from relay-secrets.ps1; $false = legacy behavior
if ($YT_AUTOCREATE -and -not $script:ytEnsured) {
  try {
    Invoke-RestMethod -Uri $YTBCAST_API -Method Post `
      -Headers @{ 'x-server-key' = $SERVER_KEY } -TimeoutSec 15 | Out-Null
    $script:ytEnsured = $true
    Log 'YouTube broadcast ensured'
  } catch { Log "YouTube broadcast ensure failed: $($_.Exception.Message)" }
}
```

- Gate the youtube entry in `Converge-Fanout` on `$script:ytEnsured` for up to
  ~3 failed ticks, then start the push anyway (graceful degradation to today's
  behavior — Twitch is never held up).
- Reset `$script:ytEnsured = $false` in `Stop-All`.
- Delete the old `$YTID_API` fetch block (`ytFetched`) — the new endpoint stores
  the id synchronously; no more Data-API search, no more index lag.

### 4. Admin OAuth endpoints (new, one-time use but keep for token rotation)

- `GET /api/admin/youtube-oauth/start` — `requireAdminAuth`; redirects to
  `accounts.google.com/o/oauth2/v2/auth` with `access_type=offline&prompt=consent`,
  `state` = signed nonce.
- `GET /api/admin/youtube-oauth/callback` — exchanges the code, then
  `channels.list?part=id&mine=true` and **asserts the channel id is
  `UCAMhFgnOL4RrYNersrqeUbQ` (Fresh Wax)** — reject anything else (two-channel
  trap). Displays the refresh token once for manual `wrangler pages secret put`;
  never logs or stores it elsewhere.

### 5. Config

| Name | Where | Value |
|---|---|---|
| `YOUTUBE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | Pages secrets | from setup |
| `YOUTUBE_CHANNEL_ID` | Pages env | `UCAMhFgnOL4RrYNersrqeUbQ` |
| `$YT_AUTOCREATE`, `$YTBCAST_API` | `relay-secrets.ps1` (host) | `$true`, `https://freshwax.co.uk/api/livestream/youtube-broadcast` |

---

## Failure modes

| Failure | Behavior |
|---|---|
| Refresh token revoked / consent lost | Endpoint 502 + `/admin/errors` entry; relay logs, pushes anyway after 3 ticks (a dashboard-made waiting broadcast still works as fallback) |
| YouTube API quota/outage | same graceful path |
| Two broadcasts risk (double tick / dashboard visit raced) | idempotent ensure (reuse `active` → `upcoming` → insert) |
| Wrong channel consented | callback rejects token at setup time |
| Mid-set DJ drop >1 min | autoStop completes broadcast → cool-off (120s) → relay re-ensures → new broadcast auto-starts. Self-healing, zero touch |

## Validation plan (one test evening)

1. Deploy site + relay change with `$YT_AUTOCREATE = $true`; restart service.
2. BUTT + go live → expect: broadcast appears on Fresh Wax channel titled
   "Code One — Live on Fresh Wax", auto-starts ~30s, slot's `youtubeLiveId`
   populated in `status/?fresh=1` within seconds.
3. Kill BUTT 3 min → reconnect → expect: old broadcast completes (autoStop),
   new one auto-created after cool-off, live again ≤ ~4 min total, no hands.
4. End slot → broadcast completes on its own; nothing left to click.
5. Rollback: `$YT_AUTOCREATE = $false` + service restart = today's behavior.

## Phase 2 (optional, not in scope)

- Retitle live broadcast on DJ handover without source gap
  (`liveBroadcasts.update` on primaryStream change).
- `/live` page YouTube chat embed using the now-reliable `youtubeLiveId`.
- Auto-set broadcast thumbnail from DJ avatar (`thumbnails.set`).

**Estimated effort**: ~250-300 lines TS (lib + 3 endpoints), ~15 lines PowerShell,
15 min console setup, one test evening.
