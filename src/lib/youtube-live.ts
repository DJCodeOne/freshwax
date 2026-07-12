// src/lib/youtube-live.ts
// YouTube Live broadcast automation for the multistream relay.
//
// Authenticates as the Fresh Wax brand channel (UCAMhFgnOL4RrYNersrqeUbQ) via a
// long-lived OAuth refresh token (Pages secrets) and provides an idempotent
// "ensure broadcast" used by /api/livestream/youtube-broadcast: reuse the live
// broadcast if one is already bound to our reusable key, else reuse + retitle a
// waiting one, else insert + bind a new one with auto-start/auto-stop.
//
// Why this exists: the Fresh Wax channel has NO default stream key (custom
// "FreshWaxLive" key only), so YouTube never auto-creates broadcasts on stream
// arrival — without this, someone must open the Studio Go-Live dashboard after
// every ended stream. Full context: scripts/mediamtx/YOUTUBE-AUTOCREATE-SPEC.md

import { createLogger, fetchWithTimeout } from './api-utils';
import { kvGet, kvSet } from './kv-cache';
import { TIMEOUTS } from './timeouts';

const log = createLogger('[youtube-live]');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';

export const FRESHWAX_CHANNEL_ID = 'UCAMhFgnOL4RrYNersrqeUbQ';
// snippet.title of the reusable stream key the relay pushes to
const STREAM_TITLE = 'FreshWaxLive';

const KV_ACCESS_TOKEN = 'youtube:oauth-access-token';
const KV_STREAM_ID = 'youtube:live-stream-id';

interface YouTubeEnv {
  YOUTUBE_OAUTH_CLIENT_ID?: string;
  YOUTUBE_OAUTH_CLIENT_SECRET?: string;
  YOUTUBE_OAUTH_REFRESH_TOKEN?: string;
  [key: string]: unknown;
}

export interface EnsuredBroadcast {
  videoId: string;
  reused: 'active' | 'upcoming' | false;
  watchUrl: string;
  chatUrl: string;
}

function oauthConfig(env: YouTubeEnv | undefined) {
  return {
    clientId: (env?.YOUTUBE_OAUTH_CLIENT_ID || import.meta.env.YOUTUBE_OAUTH_CLIENT_ID || '') as string,
    clientSecret: (env?.YOUTUBE_OAUTH_CLIENT_SECRET || import.meta.env.YOUTUBE_OAUTH_CLIENT_SECRET || '') as string,
    refreshToken: (env?.YOUTUBE_OAUTH_REFRESH_TOKEN || import.meta.env.YOUTUBE_OAUTH_REFRESH_TOKEN || '') as string,
  };
}

export function isYouTubeOAuthConfigured(env: YouTubeEnv | undefined): boolean {
  const cfg = oauthConfig(env);
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
}

/**
 * Exchange the stored refresh token for an access token.
 * Cached in KV for ~55 min (tokens last 60). initKVCache(env) must have run.
 */
export async function getAccessToken(env: YouTubeEnv | undefined): Promise<string> {
  const cached = await kvGet<string>(KV_ACCESS_TOKEN);
  if (cached) return cached;

  const cfg = oauthConfig(env);
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new Error('YouTube OAuth not configured (missing client id/secret/refresh token)');
  }

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, TIMEOUTS.API);

  const data = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // invalid_grant = refresh token revoked/expired — needs a re-consent via
    // /api/admin/youtube-oauth/start
    throw new Error(`YouTube token refresh failed: ${data.error || res.status} ${data.error_description || ''}`.trim());
  }

  await kvSet(KV_ACCESS_TOKEN, data.access_token, { ttl: Math.min((data.expires_in || 3600) - 300, 3300) });
  return data.access_token;
}

async function ytApi<T>(
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  params: Record<string, string>,
  jsonBody?: unknown
): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetchWithTimeout(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(jsonBody ? { body: JSON.stringify(jsonBody) } : {}),
  }, TIMEOUTS.API);

  const data = await res.json() as T & { error?: { code?: number; message?: string } };
  if (!res.ok) {
    throw new Error(`YouTube API ${path} failed: ${data?.error?.code || res.status} ${data?.error?.message || ''}`.trim());
  }
  return data;
}

interface BroadcastResource {
  id: string;
  snippet?: { title?: string; description?: string; scheduledStartTime?: string };
  status?: { lifeCycleStatus?: string };
  contentDetails?: { boundStreamId?: string };
}

/**
 * Resolve the liveStream resource id of the reusable "FreshWaxLive" key.
 * Stable value — cached in KV for 30 days.
 */
export async function getStreamId(token: string): Promise<string> {
  const cached = await kvGet<string>(KV_STREAM_ID);
  if (cached) return cached;

  const data = await ytApi<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(
    token, 'GET', 'liveStreams',
    { part: 'id,snippet', mine: 'true', maxResults: '50' }
  );

  const items = data.items || [];
  const match = items.find((s) => s.snippet?.title === STREAM_TITLE) || items[0];
  if (!match) {
    throw new Error(`No reusable live stream found on the channel (expected "${STREAM_TITLE}")`);
  }
  if (match.snippet?.title !== STREAM_TITLE) {
    log.warn(`Stream titled "${STREAM_TITLE}" not found — using "${match.snippet?.title}"`);
  }

  await kvSet(KV_STREAM_ID, match.id, { ttl: 30 * 24 * 3600 });
  return match.id;
}

async function listBoundBroadcast(
  token: string,
  streamId: string,
  broadcastStatus: 'active' | 'upcoming'
): Promise<BroadcastResource | null> {
  // NB: liveBroadcasts.list accepts exactly ONE filter — broadcastStatus already
  // scopes to the authenticated channel; adding mine=true is a 400.
  const data = await ytApi<{ items?: BroadcastResource[] }>(
    token, 'GET', 'liveBroadcasts',
    { part: 'id,snippet,status,contentDetails', broadcastStatus, maxResults: '10' }
  );
  return (data.items || []).find((b) => b.contentDetails?.boundStreamId === streamId) || null;
}

function toResult(b: BroadcastResource, reused: EnsuredBroadcast['reused']): EnsuredBroadcast {
  return {
    videoId: b.id,
    reused,
    watchUrl: `https://www.youtube.com/watch?v=${b.id}`,
    chatUrl: `https://www.youtube.com/live_chat?v=${b.id}&embed_domain=freshwax.co.uk`,
  };
}

/**
 * Idempotently make sure a broadcast bound to the FreshWaxLive key exists and is
 * either live or waiting with auto-start. Reuse order: active -> upcoming -> insert.
 */
export async function ensureBroadcast(
  env: YouTubeEnv | undefined,
  opts: { title: string; description: string }
): Promise<EnsuredBroadcast> {
  const token = await getAccessToken(env);
  const streamId = await getStreamId(token);

  // 1. Already live on our key (relay ffmpeg crash-restart) — reuse as-is.
  const active = await listBoundBroadcast(token, streamId, 'active');
  if (active) {
    log.info('Reusing active broadcast', active.id);
    return toResult(active, 'active');
  }

  // 2. Waiting broadcast bound to our key (e.g. dashboard-created) — retitle + reuse.
  const upcoming = await listBoundBroadcast(token, streamId, 'upcoming');
  if (upcoming) {
    if (upcoming.snippet && upcoming.snippet.title !== opts.title) {
      try {
        await ytApi(token, 'PUT', 'liveBroadcasts', { part: 'snippet' }, {
          id: upcoming.id,
          snippet: {
            ...upcoming.snippet,
            title: opts.title,
            description: opts.description,
            scheduledStartTime: upcoming.snippet.scheduledStartTime || new Date().toISOString(),
          },
        });
      } catch (e: unknown) {
        // Retitle is cosmetic — a stale title must not block going live.
        log.warn('Broadcast retitle failed:', e);
      }
    }
    log.info('Reusing upcoming broadcast', upcoming.id);
    return toResult(upcoming, 'upcoming');
  }

  // 3. Create + bind a fresh one.
  const inserted = await ytApi<BroadcastResource>(
    token, 'POST', 'liveBroadcasts',
    { part: 'id,snippet,contentDetails,status' },
    {
      snippet: {
        title: opts.title,
        description: opts.description,
        scheduledStartTime: new Date().toISOString(),
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        latencyPreference: 'low',
        // Monitor stream forces a manual "testing" phase — must be off for
        // unattended auto-start.
        monitorStream: { enableMonitorStream: false },
      },
    }
  );

  await ytApi(token, 'POST', 'liveBroadcasts/bind', {
    id: inserted.id,
    streamId,
    part: 'id,contentDetails',
  });

  log.info('Created + bound broadcast', inserted.id);
  return toResult(inserted, false);
}
