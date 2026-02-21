// src/pages/api/livestream/allowances.ts
// Manage DJ weekly booking allowances (admin overrides)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('livestream/allowances');

// Default limits
export const DEFAULT_WEEKLY_SLOTS = 2;
export const DEFAULT_MAX_HOURS_PER_DAY = 4;
export const MAX_BOOKING_DAYS_AHEAD = 30; // 1 month

// GET: Fetch all allowances or check specific DJ's allowance
export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`allowances:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  try {
    const url = new URL(request.url);
    const djId = url.searchParams.get('djId');

    if (djId) {
      // Get specific DJ's allowance
      const doc = await getDocument('djAllowances', djId);

      if (doc) {
        return new Response(JSON.stringify({
          success: true,
          allowance: { djId, ...doc }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Return defaults if no override
      return new Response(JSON.stringify({
        success: true,
        allowance: {
          djId,
          weeklySlots: DEFAULT_WEEKLY_SLOTS,
          maxHoursPerDay: DEFAULT_MAX_HOURS_PER_DAY,
          isDefault: true
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get all allowances (admin view) - limited to prevent runaway
    const allowances = await queryCollection('djAllowances', { limit: 200 });

    return new Response(JSON.stringify({
      success: true,
      allowances,
      defaults: {
        weeklySlots: DEFAULT_WEEKLY_SLOTS,
        maxHoursPerDay: DEFAULT_MAX_HOURS_PER_DAY,
        maxBookingDays: MAX_BOOKING_DAYS_AHEAD
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('GET Error:', error);
    return ApiErrors.serverError('Failed to fetch allowances');
  }
};

// POST: Create/update DJ allowance
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId2 = getClientId(request);
  const rateLimit2 = checkRateLimit(`allowances-write:${clientId2}`, RateLimiters.standard);
  if (!rateLimit2.allowed) {
    return rateLimitResponse(rateLimit2.retryAfter!);
  }

  const postEnv = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: postEnv?.ADMIN_UIDS, ADMIN_EMAILS: postEnv?.ADMIN_EMAILS });
  try {
    const body = await request.json();
    const postAuthError = await requireAdminAuth(request, locals, body);
    if (postAuthError) return postAuthError;
    const { djId, weeklySlots, maxHoursPerDay, reason, djName } = body;

    if (!djId) {
      return ApiErrors.badRequest('DJ ID is required');
    }

    // Validate values
    const slots = Math.min(Math.max(parseInt(weeklySlots) || DEFAULT_WEEKLY_SLOTS, 1), 14);
    const hours = Math.min(Math.max(parseInt(maxHoursPerDay) || DEFAULT_MAX_HOURS_PER_DAY, 1), 12);

    // Try to get DJ name if not provided
    let finalDjName = djName;
    if (!finalDjName) {
      // Check if djId is an email
      if (djId.includes('@')) {
        // Look up artist by email
        const artists = await queryCollection('artists', {
          filters: [{ field: 'email', op: 'EQUAL', value: djId }],
          limit: 1
        });

        if (artists.length > 0) {
          const artistData = artists[0];
          finalDjName = artistData.djName || artistData.name || djId;
        }
      } else {
        // Look up by ID
        const artistDoc = await getDocument('artists', djId);
        if (artistDoc) {
          finalDjName = artistDoc.djName || artistDoc.name || djId;
        }
      }
    }

    const allowanceData = {
      weeklySlots: slots,
      maxHoursPerDay: hours,
      reason: reason || null,
      djName: finalDjName || djId,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    // Use email or ID as document ID
    const docId = djId.includes('@') ? djId.replace(/[.@]/g, '_') : djId;

    await setDocument('djAllowances', docId, allowanceData);

    return new Response(JSON.stringify({
      success: true,
      message: 'Allowance saved',
      allowance: { djId: docId, ...allowanceData }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('POST Error:', error);
    return ApiErrors.serverError('Failed to save allowance');
  }
};

// DELETE: Remove DJ allowance (revert to defaults)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId3 = getClientId(request);
  const rateLimit3 = checkRateLimit(`allowances-delete:${clientId3}`, RateLimiters.standard);
  if (!rateLimit3.allowed) {
    return rateLimitResponse(rateLimit3.retryAfter!);
  }

  const delEnv = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: delEnv?.ADMIN_UIDS, ADMIN_EMAILS: delEnv?.ADMIN_EMAILS });
  try {
    const body = await request.json();
    const delAuthError = await requireAdminAuth(request, locals, body);
    if (delAuthError) return delAuthError;
    const { djId } = body;

    if (!djId) {
      return ApiErrors.badRequest('DJ ID is required');
    }

    const docId = djId.includes('@') ? djId.replace(/[.@]/g, '_') : djId;
    await deleteDocument('djAllowances', docId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Allowance removed, DJ will use default limits'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('DELETE Error:', error);
    return ApiErrors.serverError('Failed to remove allowance');
  }
};

// Helper function to check DJ's booking eligibility
export async function checkDJBookingEligibility(djId: string) {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + (weekStart.getDay() === 0 ? -6 : 1));
  weekStart.setHours(0, 0, 0, 0);
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  // Get DJ's allowance
  const allowance = await getDocument('djAllowances', djId);

  const weeklySlots = allowance?.weeklySlots || DEFAULT_WEEKLY_SLOTS;
  const maxHoursPerDay = allowance?.maxHoursPerDay || DEFAULT_MAX_HOURS_PER_DAY;

  // Count DJ's bookings this week
  const weekBookings = await queryCollection('livestreamSlots', {
    filters: [
      { field: 'djId', op: 'EQUAL', value: djId },
      { field: 'status', op: 'IN', value: ['scheduled', 'in_lobby', 'live', 'completed'] },
      { field: 'startTime', op: 'GREATER_THAN_OR_EQUAL', value: weekStart.toISOString() },
      { field: 'startTime', op: 'LESS_THAN', value: weekEnd.toISOString() }
    ]
  });

  const slotsUsedThisWeek = weekBookings.length;
  const canBookMoreThisWeek = slotsUsedThisWeek < weeklySlots;

  return {
    weeklySlots,
    maxHoursPerDay,
    slotsUsedThisWeek,
    slotsRemaining: Math.max(0, weeklySlots - slotsUsedThisWeek),
    canBookMoreThisWeek,
    maxBookingDays: MAX_BOOKING_DAYS_AHEAD,
    hasOverride: !!allowance
  };
}
