// src/pages/api/track-mix-download.ts
// Tracks DJ mix downloads using atomic increments

import type { APIRoute } from 'astro';
import { incrementField, updateDocument, clearCache } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ error: 'Invalid mixId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Increment downloads field and update last_downloaded_date
    const { newValue: downloads } = await incrementField('dj-mixes', mixId, 'downloads', 1);

    await updateDocument('dj-mixes', mixId, {
      last_downloaded_date: new Date().toISOString()
    });

    log.info('[track-mix-download] Mix', mixId, 'downloads:', downloads);

    // Invalidate cache for this mix
    clearCache(`doc:dj-mixes:${mixId}`);

    return new Response(JSON.stringify({
      success: true,
      downloads
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    log.error('[track-mix-download] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track download',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};