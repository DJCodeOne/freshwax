// src/pages/api/admin/update-mix.ts
// Admin endpoint to update DJ mix metadata (no ownership check)
import type { APIRoute } from 'astro';
import { initFirebaseEnv, invalidateMixesCache } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

// Helper to get admin key from environment
function getAdminKey(locals: any): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
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
    const { mixId, adminKey } = body;

    // Verify admin key
    if (adminKey !== getAdminKey(locals)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!mixId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'mixId is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build update object
    const updateData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };

    // Title
    if (body.title !== undefined && body.title !== null) {
      const title = String(body.title || '').slice(0, 80);
      updateData.title = title;
      updateData.name = title;
    }

    // DJ Name
    if (body.djName !== undefined && body.djName !== null) {
      const djName = String(body.djName || '').slice(0, 50);
      updateData.djName = djName;
      updateData.dj_name = djName;
      updateData.displayName = djName;
    }

    // Genre
    if (body.genre !== undefined && body.genre !== null) {
      updateData.genre = String(body.genre || '').slice(0, 30);
    }

    // Description / Shout Outs
    if (body.description !== undefined && body.description !== null) {
      const desc = String(body.description || '').slice(0, 500);
      updateData.description = desc;
      updateData.shoutOuts = desc;
    }

    // Artwork URL
    if (body.artworkUrl !== undefined && body.artworkUrl !== null) {
      updateData.artworkUrl = body.artworkUrl || '';
      updateData.imageUrl = body.artworkUrl || '';
      updateData.artwork_url = body.artworkUrl || '';
    }

    // Tracklist
    if (body.tracklist !== undefined && body.tracklist !== null) {
      const tracklistRaw = String(body.tracklist || '').slice(0, 2000);
      const tracklistArray = tracklistRaw.split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map((line: string) => {
          // Remove leading track numbers
          return line.replace(/^\d+[\.\)\:\-]?\s*[-\u2013\u2014]?\s*/, '').trim();
        })
        .filter((line: string) => line.length > 0);

      updateData.tracklist = tracklistRaw;
      updateData.tracklistArray = tracklistArray;
      updateData.trackCount = tracklistArray.length;
    }

    // Published status
    if (body.published !== undefined) {
      updateData.published = !!body.published;
    }

    // Allow downloads
    if (body.allowDownload !== undefined) {
      updateData.allowDownload = !!body.allowDownload;
    }

    // Featured
    if (body.featured !== undefined) {
      updateData.featured = !!body.featured;
    }

    // Duration (in seconds)
    if (body.durationSeconds !== undefined && body.durationSeconds !== null) {
      const secs = parseInt(body.durationSeconds, 10) || 0;
      updateData.durationSeconds = secs;
      // Format as MM:SS or H:MM:SS
      const hours = Math.floor(secs / 3600);
      const mins = Math.floor((secs % 3600) / 60);
      const seconds = secs % 60;
      const formatted = hours > 0
        ? `${hours}:${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${mins}:${String(seconds).padStart(2, '0')}`;
      updateData.duration = formatted;
      updateData.durationFormatted = formatted;
    }

    // User ID (for fixing ownership)
    if (body.userId !== undefined) {
      updateData.userId = body.userId;
    }

    // Use service account for authorized write
    const serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT;
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'dj-mixes', mixId, updateData);

    // Clear mixes cache so changes appear immediately
    invalidateMixesCache();

    return new Response(JSON.stringify({
      success: true,
      message: 'Mix updated successfully',
      updatedFields: Object.keys(updateData)
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin/update-mix] Error:', error);
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
