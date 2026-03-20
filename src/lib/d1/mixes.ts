// src/lib/d1/mixes.ts
// D1 operations for DJ mixes

import type { FirestoreDoc, D1Database } from './types';
import { log } from './types';

export interface D1DjMix {
  id: string;
  title: string;
  dj_name: string;
  user_id: string | null;
  genre: string;
  published: number;
  artwork_url: string | null;
  audio_url: string | null;
  plays: number;
  downloads: number;
  likes: number;
  duration_seconds: number | null;
  data: string;
  upload_date: string | null;
  created_at: string;
  updated_at: string;
}

// Convert Firebase mix document to D1 row
export function mixToD1Row(id: string, doc: FirestoreDoc): Partial<D1DjMix> {
  const djName = doc.displayName || doc.dj_name || doc.djName || doc.artist || 'Unknown DJ';
  const artworkUrl = doc.artwork_url || doc.artworkUrl || doc.coverUrl || doc.imageUrl || null;
  const audioUrl = doc.audio_url || doc.audioUrl || doc.mp3Url || doc.streamUrl || null;

  return {
    id,
    title: doc.title || doc.name || 'Untitled Mix',
    dj_name: djName,
    user_id: doc.userId || doc.user_id || null,
    genre: doc.genre || doc.genres || 'Jungle & D&B',
    published: (doc.published ?? doc.status === 'live' ?? true) ? 1 : 0,
    artwork_url: artworkUrl,
    audio_url: audioUrl,
    plays: doc.playCount || doc.plays || 0,
    downloads: doc.downloadCount || doc.downloads || 0,
    likes: doc.likeCount || doc.likes || 0,
    duration_seconds: doc.durationSeconds || doc.duration_seconds || null,
    data: JSON.stringify(doc),
    upload_date: doc.upload_date || doc.uploadedAt || doc.createdAt || null,
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to mix document
export function d1RowToMix(row: D1DjMix): FirestoreDoc | null {
  try {
    const doc = JSON.parse(row.data);
    doc.id = row.id;
    // Prefer D1 column values for stats (updated atomically, no race conditions)
    if (row.plays != null) doc.plays = row.plays;
    if (row.downloads != null) doc.downloads = row.downloads;
    if (row.likes != null) doc.likes = row.likes;
    return doc;
  } catch (error: unknown) {
    log.error('[D1] Error parsing mix data:', error);
    return null;
  }
}

export async function d1SearchPublishedMixes(db: D1Database, query: string, limit: number = 50): Promise<FirestoreDoc[]> {
  try {
    const pattern = `%${query}%`;
    const { results } = await db.prepare(
      `SELECT id, data FROM dj_mixes WHERE published = 1 AND (
        title LIKE ?1 COLLATE NOCASE OR
        dj_name LIKE ?1 COLLATE NOCASE OR
        genre LIKE ?1 COLLATE NOCASE
      ) ORDER BY upload_date DESC LIMIT ?2`
    ).bind(pattern, limit).all();

    return (results || []).map((row) => d1RowToMix(row as D1DjMix)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error searching mixes:', error);
    return [];
  }
}

export async function d1GetAllPublishedMixes(db: D1Database, limit: number = 500): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data, plays, downloads, likes FROM dj_mixes WHERE published = 1 ORDER BY upload_date DESC LIMIT ?`
    ).bind(limit).all();

    return (results || []).map((row) => d1RowToMix(row as D1DjMix)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting published mixes:', error);
    return [];
  }
}

export async function d1GetAllMixes(db: D1Database, limit: number = 500): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data, plays, downloads, likes FROM dj_mixes ORDER BY upload_date DESC LIMIT ?`
    ).bind(limit).all();

    return (results || []).map((row) => d1RowToMix(row as D1DjMix)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting all mixes:', error);
    return [];
  }
}

export async function d1GetMixById(db: D1Database, id: string): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      `SELECT id, data, plays, downloads, likes FROM dj_mixes WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToMix(row as D1DjMix) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting mix:', error);
    return null;
  }
}

export async function d1GetMixesByUser(db: D1Database, userId: string): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM dj_mixes WHERE user_id = ? ORDER BY upload_date DESC`
    ).bind(userId).all();

    return (results || []).map((row) => d1RowToMix(row as D1DjMix)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting mixes by user:', error);
    return [];
  }
}

export async function d1UpsertMix(db: D1Database, id: string, doc: FirestoreDoc): Promise<boolean> {
  try {
    const row = mixToD1Row(id, doc);

    await db.prepare(`
      INSERT INTO dj_mixes (id, title, dj_name, user_id, genre, published, artwork_url, audio_url,
        plays, downloads, likes, duration_seconds, data, upload_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        dj_name = excluded.dj_name,
        user_id = excluded.user_id,
        genre = excluded.genre,
        published = excluded.published,
        artwork_url = excluded.artwork_url,
        audio_url = excluded.audio_url,
        plays = excluded.plays,
        downloads = excluded.downloads,
        likes = excluded.likes,
        duration_seconds = excluded.duration_seconds,
        data = excluded.data,
        upload_date = excluded.upload_date,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.title, row.dj_name, row.user_id, row.genre, row.published, row.artwork_url, row.audio_url,
      row.plays, row.downloads, row.likes, row.duration_seconds, row.data, row.upload_date, row.updated_at
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error upserting mix:', error);
    return false;
  }
}

export async function d1DeleteMix(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare(`DELETE FROM dj_mixes WHERE id = ?`).bind(id).run();
    return true;
  } catch (error: unknown) {
    log.error('[D1] Error deleting mix:', error);
    return false;
  }
}
