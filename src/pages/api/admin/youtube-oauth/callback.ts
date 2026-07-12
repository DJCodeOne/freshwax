// src/pages/api/admin/youtube-oauth/callback.ts
// Google redirects here after consent. Exchanges the code, HARD-VERIFIES the
// token belongs to the Fresh Wax brand channel (two-channel trap: the account
// also owns the personal "Code One" channel), and displays the refresh token
// ONCE for manual `wrangler pages secret put YOUTUBE_OAUTH_REFRESH_TOKEN`.
// The token is never logged or stored server-side.
// Auth: single-use state nonce minted by the admin-only start endpoint.

import type { APIRoute } from 'astro';
import { initKVCache, kvGet, kvDelete } from '../../../../lib/kv-cache';
import { createLogger, fetchWithTimeout } from '../../../../lib/api-utils';
import { FRESHWAX_CHANNEL_ID } from '../../../../lib/youtube-live';
import { SITE_URL } from '../../../../lib/constants';
import { TIMEOUTS } from '../../../../lib/timeouts';

const log = createLogger('[youtube-oauth]');

export const prerender = false;

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<title>${title}</title>` +
    `<style>body{font-family:ui-monospace,monospace;background:#111;color:#eee;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.5}` +
    `code,pre{background:#222;padding:.2rem .4rem;border-radius:4px;word-break:break-all;white-space:pre-wrap}` +
    `h1{font-size:1.2rem}.ok{color:#7c5}.err{color:#e66}</style></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;
  initKVCache(env);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return htmlPage('OAuth failed', `<h1 class="err">Consent failed</h1><p>Google returned: <code>${oauthError}</code></p>`, 400);
  }

  // Validate + consume the single-use state nonce
  if (!state || !(await kvGet(`youtube:oauth-state:${state}`))) {
    return htmlPage('OAuth failed', `<h1 class="err">Invalid or expired state</h1><p>Restart the flow at <code>/api/admin/youtube-oauth/start</code> (nonce lives 10 minutes).</p>`, 403);
  }
  await kvDelete(`youtube:oauth-state:${state}`);

  if (!code) {
    return htmlPage('OAuth failed', `<h1 class="err">Missing code</h1>`, 400);
  }

  const clientId = env?.YOUTUBE_OAUTH_CLIENT_ID || import.meta.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = env?.YOUTUBE_OAUTH_CLIENT_SECRET || import.meta.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return htmlPage('OAuth failed', `<h1 class="err">OAuth client not configured</h1><p>Set <code>YOUTUBE_OAUTH_CLIENT_ID</code> / <code>_CLIENT_SECRET</code> Pages secrets first.</p>`, 503);
  }

  try {
    // Exchange the code
    const tokenRes = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: String(clientId),
        client_secret: String(clientSecret),
        redirect_uri: `${SITE_URL}/api/admin/youtube-oauth/callback`,
        grant_type: 'authorization_code',
      }).toString(),
    }, TIMEOUTS.API);

    const tokens = await tokenRes.json() as {
      access_token?: string; refresh_token?: string; error?: string; error_description?: string;
    };
    if (!tokenRes.ok || !tokens.access_token) {
      log.error('Code exchange failed:', tokens.error, tokens.error_description);
      return htmlPage('OAuth failed', `<h1 class="err">Code exchange failed</h1><p><code>${tokens.error || tokenRes.status}: ${tokens.error_description || ''}</code></p>`, 502);
    }
    if (!tokens.refresh_token) {
      return htmlPage('OAuth failed',
        `<h1 class="err">No refresh token returned</h1>` +
        `<p>Google only issues one on a fresh consent. Revoke the app's access at ` +
        `<code>myaccount.google.com/permissions</code> (as the Fresh Wax channel) and restart the flow.</p>`, 502);
    }

    // TWO-CHANNEL TRAP GUARD: the token must act as the Fresh Wax brand channel,
    // not the personal "Code One" channel.
    const chRes = await fetchWithTimeout(
      'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
      { headers: { 'Authorization': `Bearer ${tokens.access_token}` } },
      TIMEOUTS.API
    );
    const channels = await chRes.json() as { items?: Array<{ id: string; snippet?: { title?: string } }> };
    const channel = channels.items?.[0];
    if (!channel || channel.id !== FRESHWAX_CHANNEL_ID) {
      return htmlPage('Wrong channel',
        `<h1 class="err">Wrong channel: ${channel?.snippet?.title || 'unknown'} (${channel?.id || 'none'})</h1>` +
        `<p>This token is NOT for the Fresh Wax channel (<code>${FRESHWAX_CHANNEL_ID}</code>) — token discarded.</p>` +
        `<p>Restart the flow and pick <strong>Fresh Wax</strong> at the Google account chooser, not Code One.</p>`, 400);
    }

    // Success: show the refresh token ONCE for the manual secret handoff.
    return htmlPage('YouTube OAuth complete',
      `<h1 class="ok">✓ Consented as "${channel.snippet?.title}" (${channel.id})</h1>` +
      `<p>Store this refresh token as a Pages secret, then it never needs to be seen again:</p>` +
      `<pre>${tokens.refresh_token}</pre>` +
      `<p>Run:</p><pre>wrangler pages secret put YOUTUBE_OAUTH_REFRESH_TOKEN --project-name=freshwax</pre>` +
      `<p>…paste the token, then redeploy. Verify with a POST to <code>/api/livestream/youtube-broadcast</code>.</p>`
    );
  } catch (error: unknown) {
    log.error('Callback error:', error);
    return htmlPage('OAuth failed', `<h1 class="err">Unexpected error</h1><p><code>${error instanceof Error ? error.message : 'unknown'}</code></p>`, 500);
  }
};
