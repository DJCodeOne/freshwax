// src/pages/api/track-mix-download.ts
// Tracks DJ mix downloads using atomic increments

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { atomicIncrement, updateDocument, clearCache } from '../../lib/firebase-rest';

const MixIdSchema = z.object({
  mixId: z.string().min(1, 'Invalid mixId').max(200),
});

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  try {
    const body = await request.json();
    const parsed = MixIdSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid request', details: parsed.error.issues.map(i => i.message) }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const { mixId } = parsed.data;

    // Atomically increment downloads field and update last_downloaded_date
    const { newValues } = await atomicIncrement('dj-mixes', mixId, { downloads: 1 });
    const downloads = newValues.downloads ?? 0;

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
      error: 'Failed to track download'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};