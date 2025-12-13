// src/pages/api/livestream/allowances.ts
// Manage DJ weekly booking allowances (admin overrides)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Default limits
export const DEFAULT_WEEKLY_SLOTS = 2;
export const DEFAULT_MAX_HOURS_PER_DAY = 4;
export const MAX_BOOKING_DAYS_AHEAD = 30; // 1 month

// GET: Fetch all allowances or check specific DJ's allowance
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
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

    // Get all allowances (admin view)
    const allowances = await queryCollection('djAllowances');

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

  } catch (error) {
    console.error('[allowances] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch allowances'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Create/update DJ allowance
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const body = await request.json();
    const { djId, weeklySlots, maxHoursPerDay, reason, djName } = body;

    if (!djId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'DJ ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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

  } catch (error) {
    console.error('[allowances] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to save allowance'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE: Remove DJ allowance (revert to defaults)
export const DELETE: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const body = await request.json();
    const { djId } = body;

    if (!djId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'DJ ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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

  } catch (error) {
    console.error('[allowances] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to remove allowance'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
