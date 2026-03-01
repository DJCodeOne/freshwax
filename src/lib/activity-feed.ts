// src/lib/activity-feed.ts
// Core activity feed library — logs user events to D1 and provides
// global + personalised feed queries with cursor-based pagination.

import { createLogger } from './api-utils';

const logger = createLogger('activity-feed');

// ============================================
// TYPES
// ============================================

export type ActivityEventType =
  | 'new_release'
  | 'new_mix'
  | 'dj_went_live'
  | 'stream_ended'
  | 'follow'
  | 'like'
  | 'comment'
  | 'rating'
  | 'dj_support';

/** High-value event types that appear in every personalised feed regardless of follow status. */
const HIGH_VALUE_EVENTS: readonly ActivityEventType[] = [
  'new_release',
  'new_mix',
  'dj_went_live',
] as const;

export interface ActivityEvent {
  eventType: ActivityEventType;
  actorId?: string;
  actorName?: string;
  actorAvatar?: string;
  targetId?: string;
  targetType?: string;
  targetName?: string;
  targetImage?: string;
  targetUrl?: string;
  metadata?: Record<string, unknown> | string;
}

export interface ActivityFeedRow {
  id: string;
  event_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  target_id: string | null;
  target_type: string | null;
  target_name: string | null;
  target_image: string | null;
  target_url: string | null;
  metadata: string | null;
  created_at: string;
}

export interface FeedResult {
  events: ActivityFeedRow[];
  nextCursor: string | null;
}

export interface FeedOptions {
  limit?: number;
  before?: string;
}

// ============================================
// DEDUP WINDOW
// ============================================

/** Seconds within which a duplicate (same actor + event type + target) is suppressed. */
const DEDUP_WINDOW_SECONDS = 60;

// ============================================
// logActivity
// ============================================

/**
 * Insert an activity event into the `activity_feed` D1 table.
 *
 * Deduplicates: if the same actor_id + event_type + target_id was logged
 * within the last 60 seconds the insert is silently skipped.
 *
 * Non-blocking — errors are logged but never thrown.
 *
 * @returns The generated event ID, or null on failure / dedup skip.
 */
export async function logActivity(
  db: D1Database,
  event: ActivityEvent,
): Promise<string | null> {
  try {
    // --- Dedup check ---
    if (event.actorId && event.targetId) {
      const cutoff = new Date(Date.now() - DEDUP_WINDOW_SECONDS * 1000).toISOString();
      const existing = await db
        .prepare(
          `SELECT id FROM activity_feed
           WHERE actor_id = ? AND event_type = ? AND target_id = ? AND created_at > ?
           LIMIT 1`,
        )
        .bind(event.actorId, event.eventType, event.targetId, cutoff)
        .first<{ id: string }>();

      if (existing) {
        logger.debug('Dedup: skipping duplicate event', {
          eventType: event.eventType,
          actorId: event.actorId,
          targetId: event.targetId,
        });
        return null;
      }
    }

    // --- Generate ID ---
    const id = 'af_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();

    // --- Serialise metadata ---
    let metadataStr: string | null = null;
    if (event.metadata != null) {
      metadataStr =
        typeof event.metadata === 'string'
          ? event.metadata
          : JSON.stringify(event.metadata);
    }

    // --- Insert ---
    await db
      .prepare(
        `INSERT INTO activity_feed
          (id, event_type, actor_id, actor_name, actor_avatar,
           target_id, target_type, target_name, target_image, target_url,
           metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        event.eventType,
        event.actorId ?? null,
        event.actorName ?? null,
        event.actorAvatar ?? null,
        event.targetId ?? null,
        event.targetType ?? null,
        event.targetName ?? null,
        event.targetImage ?? null,
        event.targetUrl ?? null,
        metadataStr,
        now,
      )
      .run();

    logger.debug('Logged activity', { id, eventType: event.eventType });
    return id;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to log activity', { error: message, event });
    return null;
  }
}

// ============================================
// getGlobalFeed
// ============================================

/**
 * Fetch the most recent activity events across all users.
 *
 * Supports cursor-based pagination via the `before` option (ISO datetime).
 */
export async function getGlobalFeed(
  db: D1Database,
  options: FeedOptions = {},
): Promise<FeedResult> {
  try {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);

    let query: string;
    let bindings: unknown[];

    if (options.before) {
      query = `SELECT * FROM activity_feed
               WHERE created_at < ?
               ORDER BY created_at DESC
               LIMIT ?`;
      bindings = [options.before, limit];
    } else {
      query = `SELECT * FROM activity_feed
               ORDER BY created_at DESC
               LIMIT ?`;
      bindings = [limit];
    }

    const result = await db
      .prepare(query)
      .bind(...bindings)
      .all<ActivityFeedRow>();

    const events = result.results ?? [];
    const nextCursor =
      events.length === limit ? events[events.length - 1].created_at : null;

    return { events, nextCursor };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to fetch global feed', { error: message });
    return { events: [], nextCursor: null };
  }
}

// ============================================
// getPersonalizedFeed
// ============================================

/**
 * Fetch activity relevant to a specific user:
 *  - Events from artists the user follows
 *  - Events targeting the user (e.g. someone liked their track)
 *  - High-value global events (new_release, new_mix, dj_went_live)
 *
 * Supports cursor-based pagination via `before`.
 */
export async function getPersonalizedFeed(
  db: D1Database,
  userId: string,
  followedArtistIds: string[],
  options: FeedOptions = {},
): Promise<FeedResult> {
  try {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);

    // Build WHERE clauses for the three filter conditions
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    // 1. Events from followed artists
    if (followedArtistIds.length > 0) {
      const placeholders = followedArtistIds.map(() => '?').join(', ');
      conditions.push(`actor_id IN (${placeholders})`);
      bindings.push(...followedArtistIds);
    }

    // 2. Events targeting this user
    conditions.push('target_id = ?');
    bindings.push(userId);

    // 3. High-value events visible to everyone
    const hvPlaceholders = HIGH_VALUE_EVENTS.map(() => '?').join(', ');
    conditions.push(`event_type IN (${hvPlaceholders})`);
    bindings.push(...HIGH_VALUE_EVENTS);

    const whereFilter = conditions.map((c) => `(${c})`).join(' OR ');

    let cursorClause = '';
    if (options.before) {
      cursorClause = 'AND created_at < ?';
      bindings.push(options.before);
    }

    bindings.push(limit);

    const query = `SELECT * FROM activity_feed
                   WHERE (${whereFilter}) ${cursorClause}
                   ORDER BY created_at DESC
                   LIMIT ?`;

    const result = await db
      .prepare(query)
      .bind(...bindings)
      .all<ActivityFeedRow>();

    const events = result.results ?? [];
    const nextCursor =
      events.length === limit ? events[events.length - 1].created_at : null;

    return { events, nextCursor };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to fetch personalized feed', {
      error: message,
      userId,
    });
    return { events: [], nextCursor: null };
  }
}

// ============================================
// cleanupOldActivity
// ============================================

/**
 * Delete activity events older than `retentionDays` (default 90).
 *
 * Intended to be called from a scheduled cron handler.
 */
export async function cleanupOldActivity(
  db: D1Database,
  retentionDays: number = 90,
): Promise<{ deleted: number }> {
  try {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const result = await db
      .prepare(`DELETE FROM activity_feed WHERE created_at < ?`)
      .bind(cutoff)
      .run();

    const deleted = result?.meta?.changes ?? 0;
    logger.info(`Cleaned up ${deleted} old activity events (>${retentionDays}d)`);
    return { deleted };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to cleanup old activity', { error: message });
    return { deleted: 0 };
  }
}
