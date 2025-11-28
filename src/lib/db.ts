// src/lib/db.ts
import type { D1Database } from '@cloudflare/workers-types';

export interface Release {
  id: string;
  title: string;
  artist_name: string;
  release_date: string;
  is_preorder: boolean;
  has_vinyl: boolean;
  vinyl_stock: number;
  digital_price: number;
  vinyl_price: number | null;
  artwork_url: string;
  description: string | null;
  extra_notes: string | null;
  status: 'pending' | 'approved' | 'published';
  created_at: string;
}

export interface Track {
  id: string;
  release_id: string;
  track_number: number;
  title: string;
  audio_url: string;
  preview_url: string | null;
  duration: number | null;
}

export async function getAllPublishedReleases(db: D1Database): Promise<Release[]> {
  const { results } = await db
    .prepare('SELECT * FROM releases WHERE status = ? ORDER BY release_date DESC')
    .bind('published')
    .all();
  
  return results as Release[];
}

export async function getReleaseById(db: D1Database, id: string): Promise<Release | null> {
  const result = await db
    .prepare('SELECT * FROM releases WHERE id = ?')
    .bind(id)
    .first();
  
  return result as Release | null;
}

export async function getTracksByReleaseId(db: D1Database, releaseId: string): Promise<Track[]> {
  const { results } = await db
    .prepare('SELECT * FROM tracks WHERE release_id = ? ORDER BY track_number ASC')
    .bind(releaseId)
    .all();
  
  return results as Track[];
}