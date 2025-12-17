// src/pages/api/admin/toggle-mix-publish.ts
// Toggle DJ mix publish status
import type { APIRoute } from 'astro';
import { updateDocument, initFirebaseEnv, invalidateMixesCache } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { mixId, published } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'mixId is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await updateDocument('dj-mixes', mixId, {
      published: !!published,
      updatedAt: new Date().toISOString()
    });

    // Clear mixes cache so changes appear immediately
    invalidateMixesCache();

    return new Response(JSON.stringify({
      success: true,
      message: `Mix ${published ? 'published' : 'unpublished'} successfully`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[toggle-mix-publish] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
