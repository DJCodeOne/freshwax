// src/lib/livestream-slots/helpers.ts
// Shared helpers for livestream slot management
import { getDocument, queryCollection } from '../firebase-rest';
import { generateStreamKey as generateSecureStreamKey, initRed5Env } from '../red5';
import { initKVCache } from '../kv-cache';
import { d1UpsertSlot, d1UpdateSlotStatus } from '../d1-catalog';
import { isAdmin } from '../admin';
import { createLogger } from '../api-utils';

const log = createLogger('[livestream-slots]');

// Helper to initialize services
export function initServices(locals: App.Locals) {
  const env = locals?.runtime?.env;

  const firebaseProjectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const firebaseApiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

  const red5RtmpUrl = env?.RED5_RTMP_URL || import.meta.env.RED5_RTMP_URL;
  const red5HlsUrl = env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL;
  const red5Secret = env?.RED5_SIGNING_SECRET || import.meta.env.RED5_SIGNING_SECRET;

  initRed5Env({
    RED5_RTMP_URL: red5RtmpUrl,
    RED5_HLS_URL: red5HlsUrl,
    RED5_SIGNING_SECRET: red5Secret,
  });

  // Initialize KV cache for invalidation
  initKVCache(env);
}

// Helper to sync slot to D1 (non-blocking, fire-and-forget)
export async function syncSlotToD1(db: unknown, slotId: string, slotData: Record<string, unknown>): Promise<void> {
  if (!db) return;
  try {
    await d1UpsertSlot(db, slotId, slotData);
  } catch (e: unknown) {
    log.error('[D1] Error syncing slot (non-critical):', e);
  }
}

// Helper to update slot status in D1 (non-blocking)
export async function syncSlotStatusToD1(db: unknown, slotId: string, status: string, extraData?: Record<string, unknown>): Promise<void> {
  if (!db) return;
  try {
    await d1UpdateSlotStatus(db, slotId, status, extraData);
  } catch (e: unknown) {
    log.error('[D1] Error updating slot status (non-critical):', e);
  }
}

export const SLOT_DURATIONS = [30, 45, 60, 120, 180, 240];
export const MAX_BOOKING_DAYS = 30;

// SECURITY: Sanitize slot data to remove sensitive fields from public responses
export function sanitizeSlot(slot: Record<string, unknown>): Record<string, unknown> {
  if (!slot) return slot;
  const { streamKey, twitchStreamKey, rtmpUrl, ...safeSlot } = slot;
  return safeSlot;
}

export function sanitizeSlots(slots: Record<string, unknown>[]): Record<string, unknown>[] {
  return slots.map(sanitizeSlot);
}

// Server-side DJ eligibility check — mirrors check-dj-eligibility.ts logic
const REQUIRED_LIKES = 10;
export async function checkDjEligible(djId: string): Promise<{ eligible: boolean; reason?: string }> {
  try {
    // Admin bypass
    if (await isAdmin(djId)) return { eligible: true };

    // Check moderation status
    const moderation = await getDocument('djModeration', djId);
    if (moderation?.status === 'banned') return { eligible: false, reason: 'Your account has been suspended from streaming' };
    if (moderation?.status === 'hold') return { eligible: false, reason: 'Your streaming access is temporarily on hold' };

    // Check admin bypass collections
    const bypass = await getDocument('djLobbyBypass', djId);
    if (bypass) return { eligible: true };

    const userData = await getDocument('users', djId);
    if (userData?.['go-liveBypassed'] === true) return { eligible: true };

    // Must have at least 1 mix with 10+ likes
    const mixes = await queryCollection('dj-mixes', {
      filters: [{ field: 'userId', op: 'EQUAL', value: djId }]
    });
    if (mixes.length === 0) return { eligible: false, reason: 'You need to upload at least one DJ mix before you can go live' };

    const qualifying = mixes.filter((m: Record<string, unknown>) => ((m.likeCount as number) || (m.likes as number) || 0) >= REQUIRED_LIKES);
    if (qualifying.length === 0) return { eligible: false, reason: `Your mixes need at least ${REQUIRED_LIKES} likes to go live` };

    return { eligible: true };
  } catch (e: unknown) {
    log.warn('Eligibility check failed, allowing:', e);
    return { eligible: true }; // Fail open to not block DJs on transient errors
  }
}

export const DEFAULT_SETTINGS = {
  defaultDailyHours: 2,
  defaultWeeklySlots: 2,
  streamKeyRevealMinutes: 15,
  gracePeriodMinutes: 3,
  sessionEndCountdown: 10,
  allowGoLiveNow: true,
  allowGoLiveAfter: true,
  allowTakeover: true
};

// Use secure stream key generation from red5.ts
export function generateStreamKey(djId: string, slotId: string, startTime: Date, endTime: Date): string {
  return generateSecureStreamKey(djId, slotId, startTime, endTime);
}

// Server cache
const serverCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5000;

export function getFromCache(key: string): unknown | null {
  const entry = serverCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  if (entry) serverCache.delete(key);
  return null;
}

export function setCache(key: string, data: unknown): void {
  if (serverCache.size > 100) {
    const oldest = serverCache.keys().next().value;
    if (oldest) serverCache.delete(oldest);
  }
  serverCache.set(key, { data, timestamp: Date.now() });
}

export function invalidateCache(): void {
  serverCache.clear();
}

export async function getSettings() {
  try {
    const doc = await getDocument('system', 'admin-settings');
    return { ...DEFAULT_SETTINGS, ...(doc?.livestream || {}) };
  } catch (e: unknown) {
    return DEFAULT_SETTINGS;
  }
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
