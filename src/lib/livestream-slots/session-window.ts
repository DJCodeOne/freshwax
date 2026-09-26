// src/lib/livestream-slots/session-window.ts
// How long a go-live session runs, which bookings it absorbs, and which other
// DJ's booking it must respect. Pure functions (unit-tested) used by the
// go_live / go_live_now / start_relay / book handlers.
//
// Before Sep 2026 a go-live always ended at the next top of the hour and then
// marked EVERY scheduled slot of the DJ 'completed': a 20:00–22:00 booking was
// cut at 21:00 (unless the DJ tapped "keep streaming"), and a Go Live Now
// silently deleted next week's booking. Nor did go-live look at other DJs'
// bookings, so an ad-hoc stream could sit on someone's booked hour.

export const ACTIVE_BOOKING_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'in_lobby', 'queued']);

/** A booked DJ who hasn't gone live this far into their slot forfeits it. */
export const NO_SHOW_GRACE_MS = 15 * 60 * 1000;

/** How early a DJ may start the session of their own booking (relays included). */
export const EARLY_START_MS = 15 * 60 * 1000;

/** Don't start a session that another DJ's booking would end within this. */
export const MIN_SESSION_MS = 5 * 60 * 1000;

// Bookings closer together than this run as one continuous session.
const CONTIGUOUS_GAP_MS = 60 * 1000;

export interface SlotTimes {
  id?: unknown;
  djId?: unknown;
  djName?: unknown;
  status?: unknown;
  cancelled?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

function ms(v: unknown): number {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : NaN;
}

function isActiveBooking(s: SlotTimes): boolean {
  return ACTIVE_BOOKING_STATUSES.has(String(s.status)) && !s.cancelled
    && !Number.isNaN(ms(s.startTime)) && !Number.isNaN(ms(s.endTime));
}

/** The default end of an unbooked session: the next top of the hour (or the one after, from :55). */
export function nextHourEnd(now: Date): Date {
  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  end.setHours(end.getHours() + 1);
  if (now.getMinutes() >= 55) end.setHours(end.getHours() + 1);
  return end;
}

/**
 * Another DJ's booking that owns the current time: it covers now and its DJ is
 * still within the no-show grace. Going live on top of it would lock that DJ
 * out of their own slot ("Another DJ is currently live").
 */
export function findBlockingBooking<T extends SlotTimes>(slots: T[], djId: string, now: Date): T | null {
  const t = now.getTime();
  return slots.find((s) => isActiveBooking(s) && s.djId !== djId
    && ms(s.startTime) <= t && t < ms(s.endTime)
    && t - ms(s.startTime) < NO_SHOW_GRACE_MS) ?? null;
}

/** Start of the next other-DJ booking after now, if any — the latest a session may run. */
export function nextOtherBookingStart(slots: SlotTimes[], djId: string, now: Date): Date | null {
  const t = now.getTime();
  let best = NaN;
  for (const s of slots) {
    if (!isActiveBooking(s) || s.djId === djId) continue;
    const start = ms(s.startTime);
    if (start > t && (Number.isNaN(best) || start < best)) best = start;
  }
  return Number.isNaN(best) ? null : new Date(best);
}

/**
 * Plan a session starting now for `djId`:
 * - it runs to the next top of the hour, extended through the DJ's own active
 *   bookings that overlap it or follow on without a gap (so a 2-hour booking,
 *   or two consecutive 1-hour bookings, is one session);
 * - it never runs into another DJ's booking;
 * - `absorbed` lists the DJ's own bookings the session covers — the caller
 *   marks those superseded. Later bookings are left alone.
 */
export function planSession<T extends SlotTimes>(slots: T[], djId: string, now: Date): { endTime: Date; absorbed: T[] } {
  const t = now.getTime();
  let end = nextHourEnd(now).getTime();
  const own = slots
    .filter((s) => isActiveBooking(s) && s.djId === djId && ms(s.endTime) > t)
    .sort((a, b) => ms(a.startTime) - ms(b.startTime));

  const absorbed: T[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of own) {
      if (absorbed.includes(s)) continue;
      if (ms(s.startTime) <= end + CONTIGUOUS_GAP_MS) {
        absorbed.push(s);
        if (ms(s.endTime) > end) { end = ms(s.endTime); grew = true; }
      }
    }
  }

  const cap = nextOtherBookingStart(slots, djId, now);
  if (cap && cap.getTime() < end) end = cap.getTime();
  // A booking the cap cut off entirely is not covered by this session.
  return { endTime: new Date(end), absorbed: absorbed.filter((s) => ms(s.startTime) < end) };
}

/**
 * Minutes a DJ already has booked on a UTC day (the unit the daily limit uses),
 * counting active bookings and live sessions.
 */
export function bookedMinutesOnDay(slots: SlotTimes[], djId: string, day: string): number {
  let total = 0;
  for (const s of slots) {
    if (s.djId !== djId || s.cancelled) continue;
    if (!ACTIVE_BOOKING_STATUSES.has(String(s.status)) && s.status !== 'live') continue;
    const start = ms(s.startTime);
    const end = ms(s.endTime);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    if (new Date(start).toISOString().slice(0, 10) !== day) continue;
    total += Math.round((end - start) / 60000);
  }
  return total;
}
