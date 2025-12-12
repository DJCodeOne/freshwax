// src/pages/api/livestream/allowances.ts
// Manage DJ weekly booking allowances (admin overrides)

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Default limits
export const DEFAULT_WEEKLY_SLOTS = 2;
export const DEFAULT_MAX_HOURS_PER_DAY = 4;
export const MAX_BOOKING_DAYS_AHEAD = 30; // 1 month

// GET: Fetch all allowances or check specific DJ's allowance
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const djId = url.searchParams.get('djId');

    if (djId) {
      // Get specific DJ's allowance
      const doc = await db.collection('djAllowances').doc(djId).get();
      
      if (doc.exists) {
        return new Response(JSON.stringify({
          success: true,
          allowance: { djId, ...doc.data() }
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
    const snapshot = await db.collection('djAllowances').get();
    const allowances = snapshot.docs.map(doc => ({
      djId: doc.id,
      ...doc.data()
    }));

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
export const POST: APIRoute = async ({ request }) => {
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
        const artistSnapshot = await db.collection('artists')
          .where('email', '==', djId)
          .limit(1)
          .get();
        
        if (!artistSnapshot.empty) {
          const artistData = artistSnapshot.docs[0].data();
          finalDjName = artistData.djName || artistData.name || djId;
        }
      } else {
        // Look up by ID
        const artistDoc = await db.collection('artists').doc(djId).get();
        if (artistDoc.exists) {
          const artistData = artistDoc.data();
          finalDjName = artistData?.djName || artistData?.name || djId;
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
    
    await db.collection('djAllowances').doc(docId).set(allowanceData, { merge: true });

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
export const DELETE: APIRoute = async ({ request }) => {
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
    await db.collection('djAllowances').doc(docId).delete();

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
  const allowanceDoc = await db.collection('djAllowances').doc(djId).get();
  const allowance = allowanceDoc.exists ? allowanceDoc.data() : null;
  
  const weeklySlots = allowance?.weeklySlots || DEFAULT_WEEKLY_SLOTS;
  const maxHoursPerDay = allowance?.maxHoursPerDay || DEFAULT_MAX_HOURS_PER_DAY;

  // Count DJ's bookings this week
  const weekBookings = await db.collection('livestreamSlots')
    .where('djId', '==', djId)
    .where('status', 'in', ['scheduled', 'in_lobby', 'live', 'completed'])
    .where('startTime', '>=', weekStart.toISOString())
    .where('startTime', '<', weekEnd.toISOString())
    .get();

  const slotsUsedThisWeek = weekBookings.size;
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
