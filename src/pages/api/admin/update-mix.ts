// src/pages/api/admin/update-mix.ts
// Admin endpoint to update DJ mix metadata (no ownership check)
import type { APIRoute } from 'astro';
import { updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { mixId } = body;

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
    if (body.title !== undefined) {
      updateData.title = body.title.slice(0, 80);
      updateData.name = body.title.slice(0, 80);
    }

    // DJ Name
    if (body.djName !== undefined) {
      updateData.djName = body.djName.slice(0, 50);
      updateData.dj_name = body.djName.slice(0, 50);
      updateData.displayName = body.djName.slice(0, 50);
    }

    // Genre
    if (body.genre !== undefined) {
      updateData.genre = body.genre.slice(0, 30);
    }

    // Description / Shout Outs
    if (body.description !== undefined) {
      updateData.description = body.description.slice(0, 500);
      updateData.shoutOuts = body.description.slice(0, 500);
    }

    // Artwork URL
    if (body.artworkUrl !== undefined) {
      updateData.artworkUrl = body.artworkUrl;
      updateData.imageUrl = body.artworkUrl;
      updateData.artwork_url = body.artworkUrl;
    }

    // Tracklist
    if (body.tracklist !== undefined) {
      const tracklistRaw = body.tracklist.slice(0, 2000);
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

    // User ID (for fixing ownership)
    if (body.userId !== undefined) {
      updateData.userId = body.userId;
    }

    await updateDocument('dj-mixes', mixId, updateData);

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
