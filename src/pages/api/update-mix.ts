// src/pages/api/update-mix.ts
// API endpoint to update mix description and backfill userId - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { d1UpsertMix } from '../../lib/d1-catalog';
import { isAdmin } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-mix:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;

  try {
    // SECURITY: Verify authentication via token (not cookies which are spoofable)
    const { userId: currentUserId, error: authError } = await verifyRequestUser(request);
    if (!currentUserId || authError) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

    const { mixId, title, description, tracklist, artworkUrl, partnerId } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing mixId'
      }), {
        status: 400,
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

    // Orphaned mixes (no userId) can only be backfilled by admins
    let canBackfillOwnership = false;
    if (!mixData?.userId && currentUserId) {
      canBackfillOwnership = await isAdmin(currentUserId);
    }

    if (!isOwner && !canBackfillOwnership) {
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

    // Update title if provided (max 50 chars)
    if (title !== undefined) {
      updateData.title = title.slice(0, 50);
      updateData.name = title.slice(0, 50);
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
        error: 'Database update failed'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        // Get the full updated document for D1
        const updatedMix = await getDocument('dj-mixes', mixId);
        if (updatedMix) {
          await d1UpsertMix(db, mixId, updatedMix);
        }
      } catch (d1Error) {
        // Log D1 error but don't fail the request
        console.error('[update-mix] D1 dual-write failed (non-critical):', d1Error);
      }
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
      error: 'Failed to update mix'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
