// src/pages/api/get-comments-batch.ts
// Batch fetch comments for multiple releases in a single API call
// Comments are stored in the release document, so this uses getDocumentsBatch

import type { APIRoute } from 'astro';
import { getDocumentsBatch, CACHE_TTL, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

// Simple in-memory cache for API responses
const responseCache = new Map<string, { data: any; expires: number }>();
const RESPONSE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes (comments may update more frequently)

function getCachedResponse(key: string): any | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expires) {
    return entry.data;
  }
  if (entry) {
    responseCache.delete(key);
  }
  return null;
}

function setCachedResponse(key: string, data: any): void {
  responseCache.set(key, {
    data,
    expires: Date.now() + RESPONSE_CACHE_TTL
  });

  // Cleanup if cache grows too large
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now >= v.expires) {
        responseCache.delete(k);
      }
    }
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { releaseIds } = body;

    if (!releaseIds || !Array.isArray(releaseIds)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseIds array required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limit batch size to prevent abuse
    const limitedIds = releaseIds.slice(0, 30);

    // Check response cache first
    const cacheKey = `comments:${limitedIds.sort().join(',')}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return new Response(JSON.stringify({
        success: true,
        comments: cached,
        source: 'cache'
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=120'
        }
      });
    }

    // Fetch releases in batch (comments are stored in release documents)
    const releasesMap = await getDocumentsBatch('releases', limitedIds, CACHE_TTL.COMMENTS);

    // Extract comments from releases
    const comments: Record<string, any[]> = {};

    for (const releaseId of limitedIds) {
      const release = releasesMap.get(releaseId);
      if (release && release.comments) {
        // Sort comments by timestamp (newest first)
        comments[releaseId] = [...release.comments].sort((a: any, b: any) => {
          const dateA = new Date(a.timestamp || a.createdAt || 0).getTime();
          const dateB = new Date(b.timestamp || b.createdAt || 0).getTime();
          return dateB - dateA;
        });
      } else {
        comments[releaseId] = [];
      }
    }

    // Cache the response
    setCachedResponse(cacheKey, comments);

    return new Response(JSON.stringify({
      success: true,
      comments,
      source: 'firestore'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120'
      }
    });

  } catch (error) {
    console.error('[get-comments-batch] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch comments',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Also support GET with query params for simpler usage
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');

  if (!idsParam) {
    return new Response(JSON.stringify({
      success: false,
      error: 'ids query parameter required (comma-separated)'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const releaseIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);

  if (releaseIds.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No valid release IDs provided'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Reuse POST logic
  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseIds })
  });

  return POST({ request: syntheticRequest, locals } as any);
};
