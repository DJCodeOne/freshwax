// src/pages/api/admin/cleanup-streams.ts
// Clean up stale "live" streams that weren't properly ended
// GET: List stale streams
// POST: Mark stale streams as completed

import type { APIRoute } from 'astro';
import { queryCollection, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

function initFirebase(locals: any) {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET: List all slots marked as "live"
export const GET: APIRoute = async ({ locals }) => {
  initFirebase(locals);

  try {
    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 50,
      skipCache: true
    });

    const now = new Date();
    const slotsWithAge = liveSlots.map(slot => {
      const startedAt = slot.startedAt || slot.liveStartTime || slot.startTime;
      const startDate = startedAt ? new Date(startedAt) : null;
      const ageMs = startDate ? now.getTime() - startDate.getTime() : 0;
      const ageHours = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10;

      return {
        id: slot.id,
        djName: slot.djName,
        djId: slot.djId,
        title: slot.title,
        startedAt: startedAt,
        ageHours: ageHours,
        status: slot.status,
        isStale: ageHours > 6, // Consider stale if older than 6 hours
      };
    });

    // Sort by age descending (oldest first)
    slotsWithAge.sort((a, b) => b.ageHours - a.ageHours);

    const staleCount = slotsWithAge.filter(s => s.isStale).length;

    return new Response(JSON.stringify({
      success: true,
      totalLive: slotsWithAge.length,
      staleCount,
      slots: slotsWithAge,
      message: staleCount > 0
        ? `Found ${staleCount} stale streams. POST to this endpoint to clean them up.`
        : 'No stale streams found.'
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to list streams'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Clean up stale streams
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    let maxAgeHours = 6; // Default: streams older than 6 hours are stale
    let specificIds: string[] = [];

    try {
      const body = await request.json();
      if (body.maxAgeHours) maxAgeHours = body.maxAgeHours;
      if (body.ids && Array.isArray(body.ids)) specificIds = body.ids;
    } catch {
      // No body - use defaults
    }

    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 50,
      skipCache: true
    });

    const now = new Date();
    const nowISO = now.toISOString();
    const results: any[] = [];

    for (const slot of liveSlots) {
      const startedAt = slot.startedAt || slot.liveStartTime || slot.startTime;
      const startDate = startedAt ? new Date(startedAt) : null;
      const ageMs = startDate ? now.getTime() - startDate.getTime() : 0;
      const ageHours = ageMs / (1000 * 60 * 60);

      // Clean up if:
      // 1. Specific IDs provided and this is one of them, OR
      // 2. No specific IDs and stream is older than maxAgeHours
      const shouldClean = specificIds.length > 0
        ? specificIds.includes(slot.id)
        : ageHours > maxAgeHours;

      if (shouldClean) {
        try {
          await updateDocument('livestreamSlots', slot.id, {
            status: 'completed',
            endedAt: nowISO,
            updatedAt: nowISO,
            cleanupReason: 'stale_stream_cleanup'
          });

          results.push({
            id: slot.id,
            djName: slot.djName,
            ageHours: Math.round(ageHours * 10) / 10,
            status: 'cleaned',
          });
        } catch (e: any) {
          results.push({
            id: slot.id,
            djName: slot.djName,
            status: 'error',
            error: e.message
          });
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      cleaned: results.filter(r => r.status === 'cleaned').length,
      errors: results.filter(r => r.status === 'error').length,
      results,
      message: results.length > 0
        ? `Cleaned up ${results.filter(r => r.status === 'cleaned').length} stale streams`
        : 'No streams needed cleanup'
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to clean up streams'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
