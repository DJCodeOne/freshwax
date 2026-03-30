import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, getDocument, setDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('bookings');

const BookingsGetSchema = z.object({
  action: z.enum(['getDailyInfo', 'getSchedule', 'getMyBookings']),
  uid: z.string().min(1).max(200).optional(),
  date: z.string().min(1).max(30).optional(),
});

const BookingsPostSchema = z.object({
  action: z.enum(['createBooking', 'cancelBooking']),
  uid: z.string().min(1).max(200).optional(),
  djName: z.string().min(1).max(200).optional(),
  streamTitle: z.string().min(1).max(300).optional(),
  description: z.string().max(1000).optional(),
  slots: z.array(z.string().max(50)).max(10).optional(),
  durationType: z.enum(['1hr', '2hr']).optional(),
  bookingId: z.string().min(1).max(200).optional(),
});

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

  // Get bookings for this user with limit to prevent runaway
  const bookings = await queryCollection('livestream-bookings', {
    filters: [{ field: 'djId', op: 'EQUAL', value: uid }],
    skipCache: true,
    limit: 50  // Max 50 bookings per user to prevent runaway
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

  // Query bookings for this day only (server-side date filter)
  const bookings = await queryCollection('livestream-bookings', {
    filters: [
      { field: 'startTime', op: 'GREATER_THAN_OR_EQUAL', value: dayStart.toISOString() },
      { field: 'startTime', op: 'LESS_THAN_OR_EQUAL', value: dayEnd.toISOString() },
    ],
    skipCache: true,
    limit: 100
  });

  for (const booking of bookings) {
    const bookingStart = booking.startTime ? new Date(booking.startTime) : null;
    if (!bookingStart) continue;

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

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = locals.runtime.env;

  const parsedGet = BookingsGetSchema.safeParse({
    action: url.searchParams.get('action') ?? '',
    uid: url.searchParams.get('uid') || undefined,
    date: url.searchParams.get('date') || undefined,
  });
  if (!parsedGet.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const action = parsedGet.data.action;
  const uid = parsedGet.data.uid || null;
  const dateStr = parsedGet.data.date || null;

  try {
    // Get user's daily bookings and allowance — requires auth
    if (action === 'getDailyInfo' && uid && dateStr) {
      const { userId: verifiedUid, error: authError } = await verifyRequestUser(request);
      if (authError || !verifiedUid || verifiedUid !== uid) {
        return ApiErrors.unauthorized('Authentication required');
      }

      const date = new Date(dateStr);
      const usedHours = await getUserDailyHours(uid, date);

      return successResponse({ usedHours, remainingHours: MAX_DAILY_HOURS - usedHours, maxHours: MAX_DAILY_HOURS });
    }

    // Get schedule for a day (public — shows who's streaming when)
    if (action === 'getSchedule' && dateStr) {
      const date = new Date(dateStr);
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      // Query bookings for this day only (server-side date filter)
      const dayBookings = await queryCollection('livestream-bookings', {
        filters: [
          { field: 'startTime', op: 'GREATER_THAN_OR_EQUAL', value: startOfDay.toISOString() },
          { field: 'startTime', op: 'LESS_THAN_OR_EQUAL', value: endOfDay.toISOString() },
        ],
        skipCache: true,
        limit: 100
      });

      const bookings = dayBookings
        .map(b => ({
          id: b.id,
          djName: b.djName,
          streamTitle: b.streamTitle,
          startTime: b.startTime instanceof Date ? b.startTime.toISOString() : b.startTime,
          duration: b.duration || 1,
          djId: b.djId
        }))
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

      return successResponse({ bookings }, 200, { headers: { 'Cache-Control': 'public, max-age=60' } });
    }

    // Get user's upcoming bookings — requires auth
    if (action === 'getMyBookings' && uid) {
      const { userId: verifiedUid, error: authErr } = await verifyRequestUser(request);
      if (authErr || !verifiedUid || verifiedUid !== uid) {
        return ApiErrors.unauthorized('Authentication required');
      }
      const now = new Date();
      now.setHours(now.getHours() - 2); // Include currently live

      const allBookings = await queryCollection('livestream-bookings', {
        filters: [{ field: 'djId', op: 'EQUAL', value: uid }],
        skipCache: true,
        limit: 50  // Max 50 bookings per user to prevent runaway
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

      return successResponse({ bookings });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('Bookings API GET error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

export const POST: APIRoute = async ({ request }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`bookings:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify the user is authenticated
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const body = await request.json();
    const parsedPost = BookingsPostSchema.safeParse(body);
    if (!parsedPost.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { action, uid, djName, streamTitle, description, slots, durationType } = parsedPost.data;

    // Verify the authenticated user matches the uid in the request
    if (uid && verifiedUserId !== uid) {
      return ApiErrors.forbidden('You can only manage your own bookings');
    }

    // Use verified userId for all operations
    const authenticatedUid = verifiedUserId;

    // Create booking(s)
    if (action === 'createBooking') {
      if (!djName || !streamTitle || !slots || slots.length === 0) {
        return ApiErrors.badRequest('Missing required fields: djName, streamTitle, and slots are required');
      }

      // Verify DJ eligibility
      if (!(await isDJEligible(authenticatedUid))) {
        return ApiErrors.forbidden('You are not DJ eligible');
      }

      // Parse slots
      const slotDates = slots.map((s: string) => new Date(s));
      if (slotDates.length === 0) {
        return ApiErrors.badRequest('No valid slot dates provided');
      }
      const bookingDate = slotDates[0];

      // Check daily allowance
      const usedHours = await getUserDailyHours(authenticatedUid, bookingDate);
      const requestedHours = durationType === '2hr' ? 2 : slotDates.length;

      if (usedHours + requestedHours > MAX_DAILY_HOURS) {
        return ApiErrors.badRequest(`You only have ${MAX_DAILY_HOURS - usedHours} hours remaining today`);
      }

      // Validate slots are available
      for (const slotDate of slotDates) {
        const duration = durationType === '2hr' ? 2 : 1;
        const availability = await isSlotAvailable(slotDate, duration);

        if (!availability.available) {
          return ApiErrors.badRequest(availability.conflict);
        }
      }

      // Create booking(s) using REST API
      const createdBookings: string[] = [];

      if (durationType === '2hr') {
        // Single 2-hour booking
        const startTime = new Date(Math.min(...slotDates.map((d: Date) => d.getTime())));
        const bookingId = generateId();

        await setDocument('livestream-bookings', bookingId, {
          djId: authenticatedUid,
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
            djId: authenticatedUid,
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

      return successResponse({ bookingIds: createdBookings, message: 'Booking confirmed!' });
    }

    // Cancel booking
    if (action === 'cancelBooking') {
      const bookingId = parsedPost.data.bookingId;

      if (!bookingId) {
        return ApiErrors.badRequest('Booking ID required');
      }

      // Get booking
      const booking = await getDocument('livestream-bookings', bookingId);

      if (!booking) {
        return ApiErrors.notFound('Booking not found');
      }

      // Verify ownership using authenticated user ID
      if (booking.djId !== authenticatedUid) {
        return ApiErrors.forbidden('You can only cancel your own bookings');
      }

      // Check if booking can be cancelled (at least 30 mins before)
      const startTime = booking.startTime ? new Date(booking.startTime) : new Date();
      const now = new Date();
      const thirtyMinsFromNow = new Date(now.getTime() + 30 * 60 * 1000);

      if (startTime <= thirtyMinsFromNow) {
        return ApiErrors.badRequest('Cannot cancel within 30 minutes of start time');
      }

      // Mark as cancelled (or delete)
      await setDocument('livestream-bookings', bookingId, {
        ...booking,
        status: 'cancelled',
        cancelledAt: new Date().toISOString()
      });

      return successResponse({ message: 'Booking cancelled. Slot is now available.' });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('Bookings API POST error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
