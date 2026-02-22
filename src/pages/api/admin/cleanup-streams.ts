// src/pages/api/admin/cleanup-streams.ts
// Clean up stale "live" streams and monitor stream health
// GET: List stale streams and check active stream health
// POST: Mark stale/disconnected streams as completed

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, ApiErrors, fetchWithTimeout } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const cleanupStreamsPostSchema = z.object({
  maxAgeHours: z.number().positive().optional(),
  ids: z.array(z.string().min(1)).optional(),
  cleanDisconnected: z.boolean().optional(),
  disconnectThreshold: z.number().positive().optional(),
}).passthrough();

function initServices(locals: App.Locals) {
  const env = locals.runtime.env;
  initRed5Env({
    RED5_RTMP_URL: env?.RED5_RTMP_URL || import.meta.env.RED5_RTMP_URL,
    RED5_HLS_URL: env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL,
  });
}

// Check if a stream is actually broadcasting
async function checkStreamHealth(streamKey: string): Promise<{ isLive: boolean; error?: string }> {
  try {
    const hlsUrl = buildHlsUrl(streamKey);
    const response = await fetchWithTimeout(hlsUrl.replace('/index.m3u8', '/'), {
      method: 'HEAD'
    }, 5000);
    return { isLive: response.ok || response.status === 200 };
  } catch (error: unknown) {
    return { isLive: false, error: 'Connection failed' };
  }
}

// GET: List all slots marked as "live" with health check
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`cleanup-streams-get:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  initServices(locals);

  // Check admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const checkHealth = url.searchParams.get('checkHealth') === 'true';

  try {
    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 50,
      skipCache: true
    });

    const now = new Date();

    // Process slots with optional health check
    const slotsWithInfo = await Promise.all(liveSlots.map(async slot => {
      const startedAt = slot.startedAt || slot.liveStartTime || slot.startTime;
      const startDate = startedAt ? new Date(startedAt) : null;
      const ageMs = startDate ? now.getTime() - startDate.getTime() : 0;
      const ageHours = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10;

      let healthStatus = null;
      if (checkHealth && slot.streamKey) {
        healthStatus = await checkStreamHealth(slot.streamKey);
      }

      return {
        id: slot.id,
        djName: slot.djName,
        djId: slot.djId,
        title: slot.title,
        streamKey: slot.streamKey,
        startedAt: startedAt,
        ageHours: ageHours,
        status: slot.status,
        isStale: ageHours > 6, // Consider stale if older than 6 hours
        isDisconnected: healthStatus ? !healthStatus.isLive : null,
        healthCheck: healthStatus,
      };
    }));

    // Sort by age descending (oldest first)
    slotsWithInfo.sort((a, b) => b.ageHours - a.ageHours);

    const staleCount = slotsWithInfo.filter(s => s.isStale).length;
    const disconnectedCount = slotsWithInfo.filter(s => s.isDisconnected === true).length;

    return new Response(JSON.stringify({
      success: true,
      totalLive: slotsWithInfo.length,
      staleCount,
      disconnectedCount: checkHealth ? disconnectedCount : null,
      slots: slotsWithInfo,
      healthCheckPerformed: checkHealth,
      message: staleCount > 0 || disconnectedCount > 0
        ? `Found ${staleCount} stale and ${disconnectedCount} disconnected streams. POST to clean them up.`
        : 'All streams are healthy.'
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    return ApiErrors.serverError('Failed to list streams');
  }
};

// POST: Clean up stale and disconnected streams
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`cleanup-streams-post:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  initServices(locals);

  try {
    let maxAgeHours = 6; // Default: streams older than 6 hours are stale
    let specificIds: string[] = [];
    let cleanDisconnected = false; // Also clean disconnected streams
    let disconnectThreshold = 2; // Minutes without signal before marking disconnected

    const body = await parseJsonBody<{
      maxAgeHours?: number;
      ids?: string[];
      cleanDisconnected?: boolean;
      disconnectThreshold?: number;
    }>(request);

    // Check admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    // Parse body parameters
    if (body?.maxAgeHours) maxAgeHours = body.maxAgeHours;
    if (body?.ids && Array.isArray(body.ids)) specificIds = body.ids;
    if (body?.cleanDisconnected) cleanDisconnected = true;
    if (body?.disconnectThreshold) disconnectThreshold = body.disconnectThreshold;

    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 50,
      skipCache: true
    });

    const now = new Date();
    const nowISO = now.toISOString();
    const results: Record<string, unknown>[] = [];

    for (const slot of liveSlots) {
      const startedAt = slot.startedAt || slot.liveStartTime || slot.startTime;
      const startDate = startedAt ? new Date(startedAt) : null;
      const ageMs = startDate ? now.getTime() - startDate.getTime() : 0;
      const ageHours = ageMs / (1000 * 60 * 60);

      // Check stream health if cleaning disconnected streams
      let isDisconnected = false;
      let healthResult = null;
      if (cleanDisconnected && slot.streamKey) {
        healthResult = await checkStreamHealth(slot.streamKey);
        isDisconnected = !healthResult.isLive;
      }

      // Clean up if:
      // 1. Specific IDs provided and this is one of them, OR
      // 2. No specific IDs and stream is older than maxAgeHours, OR
      // 3. cleanDisconnected is true and stream is disconnected
      const shouldClean = specificIds.length > 0
        ? specificIds.includes(slot.id)
        : (ageHours > maxAgeHours || (cleanDisconnected && isDisconnected));

      if (shouldClean) {
        const cleanupReason = isDisconnected ? 'stream_disconnected' : 'stale_stream_cleanup';

        try {
          await updateDocument('livestreamSlots', slot.id, {
            status: 'completed',
            endedAt: nowISO,
            updatedAt: nowISO,
            cleanupReason,
            autoEnded: true
          });

          results.push({
            id: slot.id,
            djName: slot.djName,
            ageHours: Math.round(ageHours * 10) / 10,
            reason: cleanupReason,
            status: 'cleaned',
          });
        } catch (e: unknown) {
          results.push({
            id: slot.id,
            djName: slot.djName,
            status: 'error',
            error: 'Cleanup error'
          });
        }
      }
    }

    const cleanedCount = results.filter(r => r.status === 'cleaned').length;
    const disconnectedCleaned = results.filter(r => r.reason === 'stream_disconnected').length;
    const staleCleaned = results.filter(r => r.reason === 'stale_stream_cleanup').length;

    return new Response(JSON.stringify({
      success: true,
      cleaned: cleanedCount,
      staleCleaned,
      disconnectedCleaned,
      errors: results.filter(r => r.status === 'error').length,
      results,
      message: cleanedCount > 0
        ? `Cleaned up ${staleCleaned} stale and ${disconnectedCleaned} disconnected streams`
        : 'No streams needed cleanup'
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    return ApiErrors.serverError('Failed to clean up streams');
  }
};
