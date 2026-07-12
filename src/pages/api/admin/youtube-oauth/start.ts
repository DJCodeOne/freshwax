// src/pages/api/admin/youtube-oauth/start.ts
// One-time (and token-rotation) OAuth consent kick-off for YouTube broadcast
// automation. Admin-only. Redirects to Google's consent screen; the operator
// MUST pick the "Fresh Wax" brand channel at the account chooser — the callback
// rejects any other channel.
// Spec: scripts/mediamtx/YOUTUBE-AUTOCREATE-SPEC.md

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/admin';
import { initKVCache, kvSet } from '../../../../lib/kv-cache';
import { errorResponse } from '../../../../lib/api-utils';
import { SITE_URL } from '../../../../lib/constants';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = locals?.runtime?.env;
  initKVCache(env);

  const clientId = env?.YOUTUBE_OAUTH_CLIENT_ID || import.meta.env.YOUTUBE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return errorResponse('YOUTUBE_OAUTH_CLIENT_ID not configured — create the OAuth client first (see YOUTUBE-AUTOCREATE-SPEC.md)', 503);
  }

  // Single-use CSRF state: unguessable, 10-min TTL, minted only by an
  // authenticated admin. The callback trusts it instead of the session cookie
  // (which may not survive the cross-site redirect back from Google).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await kvSet(`youtube:oauth-state:${state}`, true, { ttl: 600 });

  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', String(clientId));
  auth.searchParams.set('redirect_uri', `${SITE_URL}/api/admin/youtube-oauth/callback`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.force-ssl');
  // access_type=offline + prompt=consent forces a refresh token to be issued
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('state', state);

  return Response.redirect(auth.toString(), 302);
};
