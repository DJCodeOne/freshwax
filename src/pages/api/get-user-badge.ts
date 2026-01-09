// src/pages/api/get-user-badge.ts
// Get user's Plus badge from KV storage (no Firebase reads)
import type { APIRoute } from 'astro';

export const prerender = false;

// KV key for user badge
const getBadgeKey = (userId: string) => `plus-badge:${userId}`;

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'Missing userId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try KV first (fast, no quota impact)
    let badge = 'crown'; // Default
    if (kv) {
      const stored = await kv.get(getBadgeKey(userId));
      if (stored) {
        badge = stored;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      badge
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[get-user-badge] Error:', error);
    return new Response(JSON.stringify({
      success: true,
      badge: 'crown' // Default on error
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
