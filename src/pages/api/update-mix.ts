// src/pages/api/update-mix.ts
// API endpoint to update mix description and backfill userId - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { mixId, title, description, tracklist, artworkUrl, userId: userIdFromBody } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing mixId'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user ID from cookies or request body
    const partnerId = cookies.get('partnerId')?.value || '';
    const customerId = cookies.get('customerId')?.value || '';
    const firebaseUid = cookies.get('firebaseUid')?.value || '';
    const currentUserId = partnerId || customerId || firebaseUid || userIdFromBody;

    console.log('[update-mix] Auth check:', { partnerId, customerId, firebaseUid, userIdFromBody, currentUserId });

    if (!currentUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not authenticated'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the mix
    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check ownership - allow if userId matches
    const isOwner = mixData?.userId === currentUserId;

    // Also check by artist name if partnerId is set
    if (!isOwner && partnerId) {
      const partnerDoc = await getDocument('artists', partnerId);
      const partnerName = partnerDoc?.artistName?.toLowerCase().trim() || null;
      const mixDjName = (mixData?.djName || mixData?.dj_name || '').toLowerCase().trim();

      if (partnerName && mixDjName === partnerName) {
        // Owner via artist name match - OK
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized to edit this mix'
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else if (!isOwner) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not authorized to edit this mix'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build update object
    const updateData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };

    // Update title if provided
    if (title !== undefined) {
      updateData.title = title.slice(0, 80);
    }

    if (description !== undefined) {
      updateData.description = description.slice(0, 150);
      updateData.shoutOuts = description.slice(0, 150);
    }

    // Update artwork URL if provided (from artwork upload)
    if (artworkUrl) {
      updateData.artwork_url = artworkUrl;
      updateData.artworkUrl = artworkUrl;
      updateData.imageUrl = artworkUrl;
    }

    // Handle tracklist update - strip leading track numbers for consistent display
    if (tracklist !== undefined) {
      const tracklistRaw = tracklist.slice(0, 1500);
      const tracklistArray = tracklistRaw.split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map((line: string) => {
          // Remove leading track numbers in formats like: "1.", "01.", "1)", "1:", "1 -", etc.
          return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
        })
        .filter((line: string) => line.length > 0);

      updateData.tracklist = tracklistRaw;
      updateData.tracklistArray = tracklistArray;
      updateData.trackCount = tracklistArray.length;
    }

    // Backfill userId if missing
    if (!mixData?.userId && currentUserId) {
      updateData.userId = currentUserId;
    }

    try {
      await updateDocument('dj-mixes', mixId, updateData);
    } catch (updateError: any) {
      console.error('[update-mix] updateDocument error:', updateError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Database update failed',
        details: updateError?.message || 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Mix updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error updating mix:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update mix',
      details: error?.message || 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
