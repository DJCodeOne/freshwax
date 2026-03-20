// src/lib/d1/ratings.ts
// D1 operations for ratings

import type { D1Database, D1Row } from './types';
import { log } from './types';

export interface D1Rating {
  release_id: string;
  average: number;
  count: number;
  five_star_count: number;
  last_rated_at: string | null;
  updated_at: string;
}

// Get ratings for a release
export async function d1GetRatings(db: D1Database, releaseId: string): Promise<{ average: number; count: number; fiveStarCount: number } | null> {
  try {
    const row = await db.prepare(
      `SELECT average, count, five_star_count FROM ratings WHERE release_id = ?`
    ).bind(releaseId).first();

    if (!row) return null;

    const r = row as D1Row;
    return {
      average: (r.average as number) || 0,
      count: (r.count as number) || 0,
      fiveStarCount: (r.five_star_count as number) || 0
    };
  } catch (error: unknown) {
    log.error('[D1] Error getting ratings:', error);
    return null;
  }
}

// Get user's rating for a release
export async function d1GetUserRating(db: D1Database, releaseId: string, userId: string): Promise<number | null> {
  try {
    const row = await db.prepare(
      `SELECT rating FROM user_ratings WHERE release_id = ? AND user_id = ?`
    ).bind(releaseId, userId).first();

    return row ? (row as D1Row).rating as number : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting user rating:', error);
    return null;
  }
}

// Upsert a user rating and recalculate aggregate
export async function d1UpsertRating(db: D1Database, releaseId: string, userId: string, rating: number): Promise<{ average: number; count: number; fiveStarCount: number } | null> {
  try {
    const now = new Date().toISOString();
    const id = `${releaseId}_${userId}`;

    // Check if user has existing rating
    const existingRow = await db.prepare(
      `SELECT rating FROM user_ratings WHERE release_id = ? AND user_id = ?`
    ).bind(releaseId, userId).first();

    const existingRating = existingRow ? (existingRow as D1Row).rating as number : null;

    // Upsert user rating
    await db.prepare(`
      INSERT INTO user_ratings (id, release_id, user_id, rating, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rating = excluded.rating,
        updated_at = excluded.updated_at
    `).bind(id, releaseId, userId, rating, now, now).run();

    // Get current aggregate ratings
    const currentRatings = await db.prepare(
      `SELECT average, count, five_star_count FROM ratings WHERE release_id = ?`
    ).bind(releaseId).first();

    let newAverage: number;
    let newCount: number;
    let newFiveStarCount: number;

    const cr = currentRatings as D1Row | null;
    if (existingRating !== null) {
      // Update existing - recalculate
      const currentAvg = (cr?.average as number) || 0;
      const currentCount = (cr?.count as number) || 0;
      const currentFive = (cr?.five_star_count as number) || 0;

      const totalRating = (currentAvg * currentCount) - existingRating + rating;
      newAverage = currentCount > 0 ? totalRating / currentCount : rating;
      newCount = currentCount;
      newFiveStarCount = currentFive - (existingRating === 5 ? 1 : 0) + (rating === 5 ? 1 : 0);
    } else {
      // New rating
      const currentAvg = (cr?.average as number) || 0;
      const currentCount = (cr?.count as number) || 0;
      const currentFive = (cr?.five_star_count as number) || 0;

      const totalRating = currentAvg * currentCount + rating;
      newCount = currentCount + 1;
      newAverage = totalRating / newCount;
      newFiveStarCount = currentFive + (rating === 5 ? 1 : 0);
    }

    newAverage = parseFloat(newAverage.toFixed(2));

    // Upsert aggregate ratings
    await db.prepare(`
      INSERT INTO ratings (release_id, average, count, five_star_count, last_rated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(release_id) DO UPDATE SET
        average = excluded.average,
        count = excluded.count,
        five_star_count = excluded.five_star_count,
        last_rated_at = excluded.last_rated_at,
        updated_at = excluded.updated_at
    `).bind(releaseId, newAverage, newCount, newFiveStarCount, now, now).run();

    return { average: newAverage, count: newCount, fiveStarCount: newFiveStarCount };
  } catch (error: unknown) {
    log.error('[D1] Error upserting rating:', error);
    return null;
  }
}
