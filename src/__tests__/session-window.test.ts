import { describe, it, expect } from 'vitest';
import {
  nextHourEnd, findBlockingBooking, nextOtherBookingStart, planSession, bookedMinutesOnDay,
} from '../lib/livestream-slots/session-window';

const at = (iso: string) => new Date(iso);
const slot = (o: Record<string, unknown>) => ({ status: 'scheduled', djId: 'me', ...o });
const b = (id: string, start: string, end: string, o: Record<string, unknown> = {}) =>
  slot({ id, startTime: `2026-09-26T${start}:00.000Z`, endTime: `2026-09-26T${end}:00.000Z`, ...o });

describe('nextHourEnd', () => {
  it('ends at the next top of the hour, or the one after from :55', () => {
    expect(nextHourEnd(at('2026-09-26T20:10:00Z')).toISOString()).toBe('2026-09-26T21:00:00.000Z');
    expect(nextHourEnd(at('2026-09-26T20:56:00Z')).toISOString()).toBe('2026-09-26T22:00:00.000Z');
  });
});

describe('planSession', () => {
  it('runs a 2-hour booking to its end instead of cutting at the first hour', () => {
    const two = b('two', '20:00', '22:00');
    const plan = planSession([two], 'me', at('2026-09-26T20:05:00Z'));
    expect(plan.endTime.toISOString()).toBe('2026-09-26T22:00:00.000Z');
    expect(plan.absorbed.map((s) => s.id)).toEqual(['two']);
  });

  it('covers a booking the DJ starts a little early', () => {
    const plan = planSession([b('mine', '20:00', '22:00')], 'me', at('2026-09-26T19:50:00Z'));
    expect(plan.endTime.toISOString()).toBe('2026-09-26T22:00:00.000Z');
  });

  it('chains consecutive bookings into one session', () => {
    const plan = planSession([b('h2', '21:00', '22:00'), b('h1', '20:00', '21:00')], 'me', at('2026-09-26T20:02:00Z'));
    expect(plan.endTime.toISOString()).toBe('2026-09-26T22:00:00.000Z');
    expect(plan.absorbed.map((s) => s.id).sort()).toEqual(['h1', 'h2']);
  });

  it('leaves later, separate bookings alone (Go Live Now used to delete them)', () => {
    const nextWeek = slot({ id: 'nextWeek', startTime: '2026-10-03T20:00:00.000Z', endTime: '2026-10-03T21:00:00.000Z' });
    const tonight = b('tonight', '23:00', '00:00');
    const plan = planSession([nextWeek, tonight], 'me', at('2026-09-26T20:10:00Z'));
    expect(plan.endTime.toISOString()).toBe('2026-09-26T21:00:00.000Z');
    expect(plan.absorbed).toEqual([]);
  });

  it("never runs into another DJ's booking", () => {
    const theirs = b('theirs', '21:00', '22:00', { djId: 'other' });
    const mine = b('mine', '20:00', '22:00');
    expect(planSession([mine, theirs], 'me', at('2026-09-26T20:05:00Z')).endTime.toISOString()).toBe('2026-09-26T21:00:00.000Z');
    const half = b('half', '20:30', '21:30', { djId: 'other' });
    expect(planSession([half], 'me', at('2026-09-26T20:05:00Z')).endTime.toISOString()).toBe('2026-09-26T20:30:00.000Z');
  });

  it('ignores cancelled, completed and past bookings', () => {
    const plan = planSession([
      b('c', '20:00', '22:00', { status: 'cancelled' }),
      b('x', '20:00', '22:00', { cancelled: true }),
      b('done', '20:00', '22:00', { status: 'completed' }),
      b('past', '18:00', '19:00'),
    ], 'me', at('2026-09-26T20:05:00Z'));
    expect(plan.endTime.toISOString()).toBe('2026-09-26T21:00:00.000Z');
    expect(plan.absorbed).toEqual([]);
  });
});

describe('findBlockingBooking', () => {
  const theirs = b('theirs', '20:00', '21:00', { djId: 'other', djName: 'Other DJ' });

  it("blocks going live on another DJ's booked hour", () => {
    expect(findBlockingBooking([theirs], 'me', at('2026-09-26T20:05:00Z'))?.id).toBe('theirs');
  });

  it('frees the hour once the booked DJ is 15 minutes late', () => {
    expect(findBlockingBooking([theirs], 'me', at('2026-09-26T20:15:00Z'))).toBeNull();
  });

  it("never blocks on the DJ's own booking, or on inactive/future ones", () => {
    expect(findBlockingBooking([b('mine', '20:00', '21:00')], 'me', at('2026-09-26T20:05:00Z'))).toBeNull();
    expect(findBlockingBooking([{ ...theirs, status: 'cancelled' }], 'me', at('2026-09-26T20:05:00Z'))).toBeNull();
    expect(findBlockingBooking([theirs], 'me', at('2026-09-26T19:55:00Z'))).toBeNull();
  });
});

describe('nextOtherBookingStart', () => {
  it("finds the earliest upcoming booking of any other DJ", () => {
    const slots = [b('a', '22:00', '23:00', { djId: 'x' }), b('b', '21:00', '22:00', { djId: 'y' }), b('mine', '20:30', '21:00')];
    expect(nextOtherBookingStart(slots, 'me', at('2026-09-26T20:05:00Z'))?.toISOString()).toBe('2026-09-26T21:00:00.000Z');
    expect(nextOtherBookingStart([], 'me', at('2026-09-26T20:05:00Z'))).toBeNull();
  });
});

describe('bookedMinutesOnDay', () => {
  it("sums the DJ's active bookings and live sessions on that UTC day only", () => {
    const slots = [
      b('a', '20:00', '21:00'),
      b('b', '22:00', '23:00', { status: 'live' }),
      b('c', '12:00', '13:00', { status: 'completed' }),
      b('d', '14:00', '15:00', { djId: 'other' }),
      slot({ id: 'e', startTime: '2026-09-27T20:00:00.000Z', endTime: '2026-09-27T22:00:00.000Z' }),
    ];
    expect(bookedMinutesOnDay(slots, 'me', '2026-09-26')).toBe(120);
    expect(bookedMinutesOnDay(slots, 'me', '2026-09-27')).toBe(120);
    expect(bookedMinutesOnDay(slots, 'me', '2026-09-28')).toBe(0);
  });
});
