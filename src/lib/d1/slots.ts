// src/lib/d1/slots.ts
// D1 operations for livestream slots

import type { FirestoreDoc, D1Database, D1Row } from './types';
import { log } from './types';

export interface D1LivestreamSlot {
  id: string;
  dj_id: string | null;
  dj_name: string;
  title: string | null;
  genre: string | null;
  status: string;
  start_time: string;
  end_time: string;
  stream_key: string | null;
  hls_url: string | null;
  is_relay: number;
  relay_station_id: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

// Convert Firebase slot document to D1 row
export function slotToD1Row(id: string, doc: FirestoreDoc): Partial<D1LivestreamSlot> {
  return {
    id,
    dj_id: doc.djId || doc.userId || null,
    dj_name: doc.djName || doc.displayName || 'Unknown DJ',
    title: doc.title || null,
    genre: doc.genre || null,
    status: doc.status || 'scheduled',
    start_time: doc.startTime || doc.start_time || new Date().toISOString(),
    end_time: doc.endTime || doc.end_time || new Date().toISOString(),
    stream_key: doc.streamKey || null,
    hls_url: doc.hlsUrl || null,
    is_relay: doc.isRelay ? 1 : 0,
    relay_station_id: doc.relayStationId || null,
    data: JSON.stringify(doc),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to slot document
export function d1RowToSlot(row: D1LivestreamSlot): FirestoreDoc | null {
  let doc;
  try {
    doc = JSON.parse(row.data);
  } catch (error: unknown) {
    log.error('[D1] Error parsing slot data:', error);
    return null;
  }
  doc.id = row.id;
  return doc;
}

// Get all live slots (status = 'live')
export async function d1GetLiveSlots(db: D1Database): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM livestream_slots WHERE status = 'live' ORDER BY start_time ASC`
    ).all();

    return (results || []).map((row) => d1RowToSlot(row as D1LivestreamSlot)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting live slots:', error);
    return [];
  }
}

// Get scheduled slots (for today/upcoming)
export async function d1GetScheduledSlots(db: D1Database, fromTime?: string): Promise<FirestoreDoc[]> {
  try {
    const now = fromTime || new Date().toISOString();
    const { results } = await db.prepare(
      `SELECT id, data FROM livestream_slots
       WHERE status IN ('scheduled', 'in_lobby', 'live')
       AND end_time > ?
       ORDER BY start_time ASC
       LIMIT 50`
    ).bind(now).all();

    return (results || []).map((row) => d1RowToSlot(row as D1LivestreamSlot)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting scheduled slots:', error);
    return [];
  }
}

// Get slot by ID
export async function d1GetSlotById(db: D1Database, id: string): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      `SELECT id, data FROM livestream_slots WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToSlot(row as D1LivestreamSlot) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting slot:', error);
    return null;
  }
}

// Get slots by DJ
export async function d1GetSlotsByDj(db: D1Database, djId: string): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, data FROM livestream_slots WHERE dj_id = ? ORDER BY start_time DESC LIMIT 20`
    ).bind(djId).all();

    return (results || []).map((row) => d1RowToSlot(row as D1LivestreamSlot)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting slots by DJ:', error);
    return [];
  }
}

// Upsert a slot
export async function d1UpsertSlot(db: D1Database, id: string, doc: FirestoreDoc): Promise<boolean> {
  try {
    const row = slotToD1Row(id, doc);

    await db.prepare(`
      INSERT INTO livestream_slots (id, dj_id, dj_name, title, genre, status, start_time, end_time,
        stream_key, hls_url, is_relay, relay_station_id, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dj_id = excluded.dj_id,
        dj_name = excluded.dj_name,
        title = excluded.title,
        genre = excluded.genre,
        status = excluded.status,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        stream_key = excluded.stream_key,
        hls_url = excluded.hls_url,
        is_relay = excluded.is_relay,
        relay_station_id = excluded.relay_station_id,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.dj_id, row.dj_name, row.title, row.genre, row.status, row.start_time, row.end_time,
      row.stream_key, row.hls_url, row.is_relay, row.relay_station_id, row.data, row.updated_at
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error upserting slot:', error);
    return false;
  }
}

// Update slot status only (quick update)
export async function d1UpdateSlotStatus(db: D1Database, id: string, status: string, extraData?: Record<string, unknown>): Promise<boolean> {
  try {
    // First get the current data
    const row = await db.prepare(`SELECT data FROM livestream_slots WHERE id = ?`).bind(id).first();
    if (!row) {
      return false;
    }

    let doc;
    try {
      doc = JSON.parse((row as D1Row).data as string);
    } catch (parseError: unknown) {
      log.error('[D1] Error parsing slot data for status update:', parseError);
      return false;
    }

    doc.status = status;
    if (extraData) {
      Object.assign(doc, extraData);
    }

    await db.prepare(`
      UPDATE livestream_slots
      SET status = ?, data = ?, updated_at = ?
      WHERE id = ?
    `).bind(status, JSON.stringify(doc), new Date().toISOString(), id).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error updating slot status:', error);
    return false;
  }
}

// Delete a slot
export async function d1DeleteSlot(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare(`DELETE FROM livestream_slots WHERE id = ?`).bind(id).run();
    return true;
  } catch (error: unknown) {
    log.error('[D1] Error deleting slot:', error);
    return false;
  }
}
