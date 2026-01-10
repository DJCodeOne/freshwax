// src/pages/api/download-track.ts
// On-demand audio download with lazy conversion
// Uses KV for purchase verification (no Firebase reads)
// Uses R2 for caching converted audio files
// Converts WAV↔MP3 only once, then serves from cache

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

interface Env {
  CACHE?: KVNamespace;         // Purchase verification cache (shared KV)
  DB?: D1Database;             // Track metadata
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = (locals as any)?.runtime?.env as Env;

  // Rate limit downloads
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`download:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const releaseId = url.searchParams.get('releaseId');
    const trackIndex = parseInt(url.searchParams.get('track') || '0', 10);
    const format = (url.searchParams.get('format') || 'mp3').toLowerCase() as 'mp3' | 'wav';
    const userId = url.searchParams.get('userId');

    if (!releaseId) {
      return new Response(JSON.stringify({ error: 'releaseId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 1. VERIFY PURCHASE via KV (no Firebase read)
    const hasPurchased = await verifyPurchaseKV(env, userId, releaseId);
    if (!hasPurchased) {
      return new Response(JSON.stringify({ error: 'Purchase not found. Please ensure you are logged in.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. GET TRACK INFO from D1/Firebase
    const trackInfo = await getTrackFromD1(env, releaseId, trackIndex);
    if (!trackInfo) {
      return new Response(JSON.stringify({ error: 'Track not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { wavUrl, mp3Url, artistName, trackName } = trackInfo;

    // 3. CHECK IF REQUESTED FORMAT IS AVAILABLE
    let downloadUrl: string | null = null;

    if (format === 'mp3' && mp3Url?.toLowerCase().endsWith('.mp3')) {
      downloadUrl = mp3Url;
    } else if (format === 'wav' && wavUrl?.toLowerCase().endsWith('.wav')) {
      downloadUrl = wavUrl;
    }

    // If requested format is available, redirect directly
    if (downloadUrl) {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': downloadUrl,
          'Content-Disposition': `attachment; filename="${artistName} - ${trackName}.${format}"`
        }
      });
    }

    // 4. REQUESTED FORMAT NOT AVAILABLE - Check R2 cache for converted file
    const cacheKey = `converted/${releaseId}/${trackIndex}.${format}`;
    const cachedUrl = `https://cdn.freshwax.co.uk/${cacheKey}`;

    const cacheExists = await checkR2Exists(env, cacheKey);
    if (cacheExists) {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': cachedUrl,
          'Content-Disposition': `attachment; filename="${artistName} - ${trackName}.${format}"`
        }
      });
    }

    // 5. CONVERSION NEEDED - Return source file info
    // Determine what source format is available
    const sourceUrl = wavUrl || mp3Url;
    const sourceFormat = wavUrl?.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';

    return new Response(JSON.stringify({
      needsConversion: true,
      sourceUrl,
      sourceFormat,
      targetFormat: format,
      cacheKey,
      trackName: `${artistName} - ${trackName}`,
      message: `This track needs to be converted from ${sourceFormat.toUpperCase()} to ${format.toUpperCase()}. The original ${sourceFormat.toUpperCase()} file is available for immediate download.`,
      originalDownload: sourceUrl
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[download] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Download failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Verify purchase using KV cache -> Firebase fallback
async function verifyPurchaseKV(env: Env, userId: string | null, releaseId: string): Promise<boolean> {
  if (!userId) return false;

  // 1. Check KV cache first (no Firebase/D1 read)
  if (env.CACHE) {
    const purchaseKey = `purchase:${userId}:${releaseId}`;
    const hasPurchase = await env.CACHE.get(purchaseKey);
    if (hasPurchase === 'true') {
      console.log('[download] Purchase verified from KV cache');
      return true;
    }
  }

  // 2. Fallback: Query Firebase orders (one-time per user/release)
  const apiKey = import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
  try {
    // Query orders for this user
    const ordersUrl = `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/orders?key=${apiKey}`;
    const response = await fetch(ordersUrl);

    if (!response.ok) {
      console.error('[download] Firebase orders query failed');
      return false;
    }

    const data = await response.json();
    const orders = data.documents || [];

    for (const order of orders) {
      const customer = order.fields?.customer?.mapValue?.fields;
      const orderUserId = customer?.userId?.stringValue;

      if (orderUserId !== userId) continue;

      // Check items for this release
      const items = order.fields?.items?.arrayValue?.values || [];
      for (const item of items) {
        const itemFields = item.mapValue?.fields;
        const itemReleaseId = itemFields?.releaseId?.stringValue || itemFields?.id?.stringValue;

        if (itemReleaseId === releaseId) {
          // Found purchase - cache in KV for future requests
          if (env.CACHE) {
            await env.CACHE.put(`purchase:${userId}:${releaseId}`, 'true', {
              expirationTtl: 86400 * 365 // 1 year
            });
            console.log('[download] Purchase cached to KV');
          }
          return true;
        }
      }
    }

    console.log('[download] No purchase found for user/release');
    return false;
  } catch (e) {
    console.error('[download] Firebase query error:', e);
    return false;
  }
}

// Get track info from D1 with Firebase fallback
async function getTrackFromD1(env: Env, releaseId: string, trackIndex: number): Promise<{
  wavUrl: string | null;
  mp3Url: string | null;
  artistName: string;
  trackName: string;
} | null> {
  let release: any = null;

  // Try D1 first
  if (env.DB) {
    try {
      const d1Release = await env.DB.prepare(`
        SELECT artist_name, tracks FROM releases WHERE id = ?
      `).bind(releaseId).first<{ artist_name: string; tracks: string }>();

      if (d1Release) {
        release = {
          artistName: d1Release.artist_name,
          tracks: JSON.parse(d1Release.tracks || '[]')
        };
        console.log('[download] Got release from D1');
      }
    } catch (e) {
      console.error('[download] D1 error:', e);
    }
  }

  // Fall back to Firebase if D1 didn't have it
  if (!release) {
    const apiKey = import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
    try {
      const releaseUrl = `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/releases/${releaseId}?key=${apiKey}`;
      const response = await fetch(releaseUrl);

      if (response.ok) {
        const data = await response.json();
        if (data.fields) {
          release = {
            artistName: data.fields.artistName?.stringValue || data.fields.artist?.stringValue || 'Artist',
            tracks: (data.fields.tracks?.arrayValue?.values || []).map((t: any) => ({
              trackName: t.mapValue?.fields?.trackName?.stringValue || t.mapValue?.fields?.title?.stringValue,
              wavUrl: t.mapValue?.fields?.wavUrl?.stringValue,
              mp3Url: t.mapValue?.fields?.mp3Url?.stringValue
            }))
          };
          console.log('[download] Got release from Firebase');
        }
      }
    } catch (e) {
      console.error('[download] Firebase error:', e);
    }
  }

  if (!release) return null;

  const tracks = release.tracks || [];
  if (trackIndex < 0 || trackIndex >= tracks.length) return null;

  const track = tracks[trackIndex];
  const wavUrl = track.wavUrl || track.wav_url || null;
  const mp3Url = track.mp3Url || track.mp3_url || null;
  const trackName = track.trackName || track.title || `Track ${trackIndex + 1}`;

  return {
    wavUrl,
    mp3Url,
    artistName: release.artistName,
    trackName
  };
}

// Check if file exists in R2
async function checkR2Exists(env: Env, key: string): Promise<boolean> {
  // Simple HEAD request to CDN to check if file exists
  try {
    const response = await fetch(`https://cdn.freshwax.co.uk/${key}`, {
      method: 'HEAD'
    });
    return response.ok;
  } catch {
    return false;
  }
}
