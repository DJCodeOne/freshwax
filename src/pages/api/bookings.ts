import type { APIRoute } from 'astro';
import { getAdminDb, getFieldValue, getTimestamp } from '../../lib/firebase-admin';

const MAX_DAILY_HOURS = 2;

// Helper to check DJ eligibility
async function isDJEligible(db: any, uid: string): Promise<boolean> {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) return false;
  return userDoc.data()?.roles?.djEligible === true;
}

// Get user's booked hours for a specific day
async function getUserDailyHours(db: any, Timestamp: any, uid: string, date: Date): Promise<number> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const bookingsSnap = await db.collection('livestream-bookings')
    .where('djId', '==', uid)
    .where('startTime', '>=', Timestamp.fromDate(startOfDay))
    .where('startTime', '<=', Timestamp.fromDate(endOfDay))
    .get();

  let totalHours = 0;
  bookingsSnap.forEach((doc: any) => {
    totalHours += doc.data().duration || 1;
  });

  return totalHours;
}

// Check if slot is available
async function isSlotAvailable(db: any, Timestamp: any, startTime: Date, duration: number): Promise<{ available: boolean; conflict?: string }> {
  const endTime = new Date(startTime);
  endTime.setHours(endTime.getHours() + duration);

  // Get bookings that might overlap
  const dayStart = new Date(startTime);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(startTime);
  dayEnd.setHours(23, 59, 59, 999);

  const bookingsSnap = await db.collection('livestream-bookings')
    .where('startTime', '>=', Timestamp.fromDate(dayStart))
    .where('startTime', '<=', Timestamp.fromDate(dayEnd))
    .get();

  for (const doc of bookingsSnap.docs) {
    const booking = doc.data();
    const bookingStart = booking.startTime.toDate();
    const bookingEnd = new Date(bookingStart);
    bookingEnd.setHours(bookingEnd.getHours() + (booking.duration || 1));

    // Check for overlap
    if (startTime < bookingEnd && endTime > bookingStart) {
      return {
        available: false,
        conflict: `Slot conflicts with ${booking.djName}'s booking`
      };
    }
  }

  return { available: true };
}

export const GET: APIRoute = async ({ url }) => {
  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');
  const dateStr = url.searchParams.get('date');

  try {
    const db = await getAdminDb();
    const Timestamp = await getTimestamp();

    if (!db || !Timestamp) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Firebase not initialized'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // Get user's daily bookings and allowance
    if (action === 'getDailyInfo' && uid && dateStr) {
      const date = new Date(dateStr);
      const usedHours = await getUserDailyHours(db, Timestamp, uid, date);

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

      const bookingsSnap = await db.collection('livestream-bookings')
        .where('startTime', '>=', Timestamp.fromDate(startOfDay))
        .where('startTime', '<=', Timestamp.fromDate(endOfDay))
        .orderBy('startTime', 'asc')
        .get();

      const bookings: any[] = [];
      bookingsSnap.forEach((doc: any) => {
        const data = doc.data();
        bookings.push({
          id: doc.id,
          djName: data.djName,
          streamTitle: data.streamTitle,
          startTime: data.startTime.toDate().toISOString(),
          duration: data.duration || 1,
          djId: data.djId
        });
      });

      return new Response(JSON.stringify({
        success: true,
        bookings
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Get user's upcoming bookings
    if (action === 'getMyBookings' && uid) {
      const now = new Date();
      now.setHours(now.getHours() - 2); // Include currently live

      const bookingsSnap = await db.collection('livestream-bookings')
        .where('djId', '==', uid)
        .where('startTime', '>=', Timestamp.fromDate(now))
        .orderBy('startTime', 'asc')
        .get();

      const bookings: any[] = [];
      bookingsSnap.forEach((doc: any) => {
        const data = doc.data();
        bookings.push({
          id: doc.id,
          djName: data.djName,
          streamTitle: data.streamTitle,
          description: data.description,
          startTime: data.startTime.toDate().toISOString(),
          duration: data.duration || 1
        });
      });

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
      error: error.message
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const db = await getAdminDb();
    const FieldValue = await getFieldValue();
    const Timestamp = await getTimestamp();

    if (!db || !FieldValue || !Timestamp) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Firebase not initialized'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

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
      if (!(await isDJEligible(db, uid))) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You are not DJ eligible'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // Parse slots
      const slotDates = slots.map((s: string) => new Date(s));
      const bookingDate = slotDates[0];

      // Check daily allowance
      const usedHours = await getUserDailyHours(db, Timestamp, uid, bookingDate);
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
        const availability = await isSlotAvailable(db, Timestamp, slotDate, duration);

        if (!availability.available) {
          return new Response(JSON.stringify({
            success: false,
            error: availability.conflict
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }

      // Create booking(s)
      const createdBookings: string[] = [];

      if (durationType === '2hr') {
        // Single 2-hour booking
        const startTime = new Date(Math.min(...slotDates.map((d: Date) => d.getTime())));

        const docRef = await db.collection('livestream-bookings').add({
          djId: uid,
          djName,
          streamTitle,
          description: description || '',
          startTime: Timestamp.fromDate(startTime),
          duration: 2,
          status: 'confirmed',
          createdAt: FieldValue.serverTimestamp()
        });

        createdBookings.push(docRef.id);
      } else {
        // Separate 1-hour bookings
        for (const slotDate of slotDates) {
          const docRef = await db.collection('livestream-bookings').add({
            djId: uid,
            djName,
            streamTitle,
            description: description || '',
            startTime: Timestamp.fromDate(slotDate),
            duration: 1,
            status: 'confirmed',
            createdAt: FieldValue.serverTimestamp()
          });

          createdBookings.push(docRef.id);
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
      const bookingDoc = await db.collection('livestream-bookings').doc(bookingId).get();

      if (!bookingDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Booking not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      const booking = bookingDoc.data();

      // Verify ownership
      if (booking?.djId !== uid) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You can only cancel your own bookings'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // Check if booking can be cancelled (at least 30 mins before)
      const startTime = booking?.startTime.toDate();
      const now = new Date();
      const thirtyMinsFromNow = new Date(now.getTime() + 30 * 60 * 1000);

      if (startTime <= thirtyMinsFromNow) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot cancel within 30 minutes of start time'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Delete booking
      await db.collection('livestream-bookings').doc(bookingId).delete();

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
      error: error.message
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
