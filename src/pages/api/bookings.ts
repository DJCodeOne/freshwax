import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument , initFirebaseEnv } from '../../lib/firebase-rest';

const MAX_DAILY_HOURS = 2;
const PROJECT_ID = 'freshwax-store';

// Helper to check DJ eligibility
async function isDJEligible(uid: string): Promise<boolean> {
  const user = await getDocument('users', uid);
  if (!user) return false;
  return user.roles?.djEligible === true;
}

// Get user's booked hours for a specific day
async function getUserDailyHours(uid: string, date: Date): Promise<number> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  // Get all bookings for this user and filter by date locally
  const bookings = await queryCollection('livestream-bookings', {
    filters: [{ field: 'djId', op: 'EQUAL', value: uid }],
    skipCache: true
  });

  let totalHours = 0;
  for (const booking of bookings) {
    const bookingDate = booking.startTime ? new Date(booking.startTime) : null;
    if (bookingDate && bookingDate >= startOfDay && bookingDate <= endOfDay) {
      totalHours += booking.duration || 1;
    }
  }

  return totalHours;
}

// Check if slot is available
async function isSlotAvailable(startTime: Date, duration: number): Promise<{ available: boolean; conflict?: string }> {
  const endTime = new Date(startTime);
  endTime.setHours(endTime.getHours() + duration);

  const dayStart = new Date(startTime);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(startTime);
  dayEnd.setHours(23, 59, 59, 999);

  // Get all bookings and filter by date locally
  const bookings = await queryCollection('livestream-bookings', { skipCache: true });

  for (const booking of bookings) {
    const bookingStart = booking.startTime ? new Date(booking.startTime) : null;
    if (!bookingStart || bookingStart < dayStart || bookingStart > dayEnd) continue;

    const bookingEnd = new Date(bookingStart);
    bookingEnd.setHours(bookingEnd.getHours() + (booking.duration || 1));

    // Check for overlap
    if (startTime < bookingEnd && endTime > bookingStart) {
      return {
        available: false,
        conflict: `Slot conflicts with ${booking.djName || 'another DJ'}'s booking`
      };
    }
  }

  return { available: true };
}

// Generate a unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

export const GET: APIRoute = async ({ url }) => {
  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');
  const dateStr = url.searchParams.get('date');

  try {
    // Get user's daily bookings and allowance
    if (action === 'getDailyInfo' && uid && dateStr) {
      const date = new Date(dateStr);
      const usedHours = await getUserDailyHours(uid, date);

      return new Response(JSON.stringify({
        success: true,
        usedHours,
        remainingHours: MAX_DAILY_HOURS - usedHours,
        maxHours: MAX_DAILY_HOURS
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Get schedule for a day
    if (action === 'getSchedule' && dateStr) {
      const date = new Date(dateStr);
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const allBookings = await queryCollection('livestream-bookings', { skipCache: true });

      const bookings = allBookings
        .filter(b => {
          const bookingDate = b.startTime ? new Date(b.startTime) : null;
          return bookingDate && bookingDate >= startOfDay && bookingDate <= endOfDay;
        })
        .map(b => ({
          id: b.id,
          djName: b.djName,
          streamTitle: b.streamTitle,
          startTime: b.startTime instanceof Date ? b.startTime.toISOString() : b.startTime,
          duration: b.duration || 1,
          djId: b.djId
        }))
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

      return new Response(JSON.stringify({
        success: true,
        bookings
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Get user's upcoming bookings
    if (action === 'getMyBookings' && uid) {
      const now = new Date();
      now.setHours(now.getHours() - 2); // Include currently live

      const allBookings = await queryCollection('livestream-bookings', {
        filters: [{ field: 'djId', op: 'EQUAL', value: uid }],
        skipCache: true
      });

      const bookings = allBookings
        .filter(b => {
          const bookingDate = b.startTime ? new Date(b.startTime) : null;
          return bookingDate && bookingDate >= now;
        })
        .map(b => ({
          id: b.id,
          djName: b.djName,
          streamTitle: b.streamTitle,
          description: b.description,
          startTime: b.startTime instanceof Date ? b.startTime.toISOString() : b.startTime,
          duration: b.duration || 1
        }))
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

      return new Response(JSON.stringify({
        success: true,
        bookings
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('Bookings API GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { action, uid, djName, streamTitle, description, slots, durationType } = body;

    // Create booking(s)
    if (action === 'createBooking') {
      if (!uid || !djName || !streamTitle || !slots || slots.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Verify DJ eligibility
      if (!(await isDJEligible(uid))) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You are not DJ eligible'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // Parse slots
      const slotDates = slots.map((s: string) => new Date(s));
      const bookingDate = slotDates[0];

      // Check daily allowance
      const usedHours = await getUserDailyHours(uid, bookingDate);
      const requestedHours = durationType === '2hr' ? 2 : slotDates.length;

      if (usedHours + requestedHours > MAX_DAILY_HOURS) {
        return new Response(JSON.stringify({
          success: false,
          error: `You only have ${MAX_DAILY_HOURS - usedHours} hours remaining today`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Validate slots are available
      for (const slotDate of slotDates) {
        const duration = durationType === '2hr' ? 2 : 1;
        const availability = await isSlotAvailable(slotDate, duration);

        if (!availability.available) {
          return new Response(JSON.stringify({
            success: false,
            error: availability.conflict
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }

      // Create booking(s) using REST API
      const createdBookings: string[] = [];

      if (durationType === '2hr') {
        // Single 2-hour booking
        const startTime = new Date(Math.min(...slotDates.map((d: Date) => d.getTime())));
        const bookingId = generateId();

        await setDocument('livestream-bookings', bookingId, {
          djId: uid,
          djName,
          streamTitle,
          description: description || '',
          startTime: startTime.toISOString(),
          duration: 2,
          status: 'confirmed',
          createdAt: new Date().toISOString()
        });

        createdBookings.push(bookingId);
      } else {
        // Separate 1-hour bookings
        for (const slotDate of slotDates) {
          const bookingId = generateId();

          await setDocument('livestream-bookings', bookingId, {
            djId: uid,
            djName,
            streamTitle,
            description: description || '',
            startTime: slotDate.toISOString(),
            duration: 1,
            status: 'confirmed',
            createdAt: new Date().toISOString()
          });

          createdBookings.push(bookingId);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        bookingIds: createdBookings,
        message: 'Booking confirmed!'
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Cancel booking
    if (action === 'cancelBooking') {
      const { bookingId } = body;

      if (!uid || !bookingId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Get booking
      const booking = await getDocument('livestream-bookings', bookingId);

      if (!booking) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Booking not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      // Verify ownership
      if (booking.djId !== uid) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You can only cancel your own bookings'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // Check if booking can be cancelled (at least 30 mins before)
      const startTime = booking.startTime ? new Date(booking.startTime) : new Date();
      const now = new Date();
      const thirtyMinsFromNow = new Date(now.getTime() + 30 * 60 * 1000);

      if (startTime <= thirtyMinsFromNow) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot cancel within 30 minutes of start time'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Mark as cancelled (or delete)
      await setDocument('livestream-bookings', bookingId, {
        ...booking,
        status: 'cancelled',
        cancelledAt: new Date().toISOString()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Booking cancelled. Slot is now available.'
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('Bookings API POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
