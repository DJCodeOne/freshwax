// src/pages/api/playlist/server-list.ts
// Authenticated proxy for playlist.freshwax.co.uk/list
// Prevents unauthenticated inventory disclosure of 5,000+ MP3s

import type { APIRoute } from 'astro';
import { verifyRequestUser, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

const PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // SECURITY: Require authentication
  const { userId, error: authError } = await verifyRequestUser(request);
  if (!userId || authError) {
    return new Response(JSON.stringify({ error: 'Authentication required', files: [] }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const playlistToken = env?.PLAYLIST_ACCESS_TOKEN || import.meta.env.PLAYLIST_ACCESS_TOKEN || '';
    const response = await fetch(`${PLAYLIST_SERVER}/list`, {
      headers: { 'Authorization': `Bearer ${playlistToken}` },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'Playlist server unavailable', files: [] }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Playlist server error', files: [] }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
