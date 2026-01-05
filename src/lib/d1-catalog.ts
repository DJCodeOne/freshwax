// src/lib/d1-catalog.ts
// D1 database operations for releases, DJ mixes, and merch
// Used for dual-write (Firebase + D1) and D1-first reads

// =============================================
// RELEASES
// =============================================

export interface D1Release {
  id: string;
  title: string;
  artist_name: string;
  genre: string;
  release_date: string | null;
  status: string;
  published: number;
  price_per_sale: number;
  track_price: number;
  vinyl_price: number | null;
  vinyl_stock: number;
  cover_url: string | null;
  thumb_url: string | null;
  plays: number;
  downloads: number;
  views: number;
  likes: number;
  rating_avg: number;
  rating_count: number;
  data: string; // Full JSON document
  created_at: string;
  updated_at: string;
}

// Convert Firebase release document to D1 row
export function releaseToD1Row(id: string, doc: any): Partial<D1Release> {
  const artworkUrl = doc.coverUrl || doc.coverArtUrl || doc.artworkUrl || doc.thumbUrl || doc.imageUrl || null;
  const thumbUrl = doc.thumbUrl || artworkUrl;

  return {
    id,
    title: doc.title || doc.releaseName || 'Untitled',
    artist_name: doc.artistName || doc.artist || 'Unknown Artist',
    genre: doc.genre || 'Jungle & D&B',
    release_date: doc.releaseDate || null,
    status: doc.status || 'pending',
    published: (doc.published || doc.status === 'published') ? 1 : 0,
    price_per_sale: doc.pricePerSale || doc.price || 0,
    track_price: doc.trackPrice || 0,
    vinyl_price: doc.vinylPrice || null,
    vinyl_stock: doc.vinylStock || 0,
    cover_url: artworkUrl,
    thumb_url: thumbUrl,
    plays: doc.plays || doc.playCount || 0,
    downloads: doc.downloads || doc.downloadCount || 0,
    views: doc.views || doc.viewCount || 0,
    likes: doc.likes || doc.likeCount || 0,
    rating_avg: doc.ratings?.average || doc.overallRating?.average || 0,
    rating_count: doc.ratings?.count || doc.overallRating?.count || 0,
    data: JSON.stringify(doc),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to release document
export function d1RowToRelease(row: D1Release): any {
  try {
    const doc = JSON.parse(row.data);
    // Ensure id is set
    doc.id = row.id;
    return doc;
  } catch (e) {
    console.error('[D1] Error parsing release data:', e);
    return null;
  }
}

// =============================================
// DJ MIXES
// =============================================

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
export function mixToD1Row(id: string, doc: any): Partial<D1DjMix> {
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
export function d1RowToMix(row: D1DjMix): any {
  try {
    const doc = JSON.parse(row.data);
    doc.id = row.id;
    return doc;
  } catch (e) {
    console.error('[D1] Error parsing mix data:', e);
    return null;
  }
}

// =============================================
// MERCH
// =============================================

export interface D1Merch {
  id: string;
  name: string;
  type: string | null;
  price: number;
  stock: number;
  published: number;
  image_url: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

// Convert Firebase merch document to D1 row
export function merchToD1Row(id: string, doc: any): Partial<D1Merch> {
  return {
    id,
    name: doc.name || doc.title || 'Untitled',
    type: doc.type || doc.category || null,
    price: doc.price || 0,
    stock: doc.stock || doc.quantity || 0,
    published: (doc.published ?? doc.active ?? true) ? 1 : 0,
    image_url: doc.imageUrl || doc.image || doc.images?.[0] || null,
    data: JSON.stringify(doc),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to merch document
export function d1RowToMerch(row: D1Merch): any {
  try {
    const doc = JSON.parse(row.data);
    doc.id = row.id;
    return doc;
  } catch (e) {
    console.error('[D1] Error parsing merch data:', e);
    return null;
  }
}

// =============================================
// D1 DATABASE OPERATIONS
// =============================================

type D1Database = any; // Will be typed from Cloudflare bindings

// --- RELEASES ---

export async function d1GetAllPublishedReleases(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM releases_v2 WHERE published = 1 ORDER BY release_date DESC`
    ).all();

    return (results || []).map((row: any) => d1RowToRelease(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting published releases:', e);
    return [];
  }
}

export async function d1GetReleaseById(db: D1Database, id: string): Promise<any | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM releases_v2 WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToRelease(row) : null;
  } catch (e) {
    console.error('[D1] Error getting release:', e);
    return null;
  }
}

export async function d1GetReleasesByArtist(db: D1Database, artist: string): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM releases_v2 WHERE artist_name = ? AND published = 1 ORDER BY release_date DESC`
    ).bind(artist).all();

    return (results || []).map((row: any) => d1RowToRelease(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting releases by artist:', e);
    return [];
  }
}

export async function d1UpsertRelease(db: D1Database, id: string, doc: any): Promise<boolean> {
  try {
    const row = releaseToD1Row(id, doc);

    await db.prepare(`
      INSERT INTO releases_v2 (id, title, artist_name, genre, release_date, status, published,
        price_per_sale, track_price, vinyl_price, vinyl_stock, cover_url, thumb_url,
        plays, downloads, views, likes, rating_avg, rating_count, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist_name = excluded.artist_name,
        genre = excluded.genre,
        release_date = excluded.release_date,
        status = excluded.status,
        published = excluded.published,
        price_per_sale = excluded.price_per_sale,
        track_price = excluded.track_price,
        vinyl_price = excluded.vinyl_price,
        vinyl_stock = excluded.vinyl_stock,
        cover_url = excluded.cover_url,
        thumb_url = excluded.thumb_url,
        plays = excluded.plays,
        downloads = excluded.downloads,
        views = excluded.views,
        likes = excluded.likes,
        rating_avg = excluded.rating_avg,
        rating_count = excluded.rating_count,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.title, row.artist_name, row.genre, row.release_date, row.status, row.published,
      row.price_per_sale, row.track_price, row.vinyl_price, row.vinyl_stock, row.cover_url, row.thumb_url,
      row.plays, row.downloads, row.views, row.likes, row.rating_avg, row.rating_count, row.data, row.updated_at
    ).run();

    console.log('[D1] Upserted release:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error upserting release:', e);
    return false;
  }
}

// --- DJ MIXES ---

export async function d1GetAllPublishedMixes(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM dj_mixes WHERE published = 1 ORDER BY upload_date DESC`
    ).all();

    return (results || []).map((row: any) => d1RowToMix(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting published mixes:', e);
    return [];
  }
}

export async function d1GetMixById(db: D1Database, id: string): Promise<any | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM dj_mixes WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToMix(row) : null;
  } catch (e) {
    console.error('[D1] Error getting mix:', e);
    return null;
  }
}

export async function d1GetMixesByUser(db: D1Database, userId: string): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM dj_mixes WHERE user_id = ? ORDER BY upload_date DESC`
    ).bind(userId).all();

    return (results || []).map((row: any) => d1RowToMix(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting mixes by user:', e);
    return [];
  }
}

export async function d1UpsertMix(db: D1Database, id: string, doc: any): Promise<boolean> {
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

    console.log('[D1] Upserted mix:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error upserting mix:', e);
    return false;
  }
}

export async function d1DeleteMix(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare(`DELETE FROM dj_mixes WHERE id = ?`).bind(id).run();
    console.log('[D1] Deleted mix:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error deleting mix:', e);
    return false;
  }
}

// --- MERCH ---

export async function d1GetAllPublishedMerch(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM merch WHERE published = 1 ORDER BY created_at DESC`
    ).all();

    return (results || []).map((row: any) => d1RowToMerch(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting published merch:', e);
    return [];
  }
}

export async function d1GetMerchById(db: D1Database, id: string): Promise<any | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM merch WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToMerch(row) : null;
  } catch (e) {
    console.error('[D1] Error getting merch:', e);
    return null;
  }
}

export async function d1UpsertMerch(db: D1Database, id: string, doc: any): Promise<boolean> {
  try {
    const row = merchToD1Row(id, doc);

    await db.prepare(`
      INSERT INTO merch (id, name, type, price, stock, published, image_url, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        price = excluded.price,
        stock = excluded.stock,
        published = excluded.published,
        image_url = excluded.image_url,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.name, row.type, row.price, row.stock, row.published, row.image_url, row.data, row.updated_at
    ).run();

    console.log('[D1] Upserted merch:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error upserting merch:', e);
    return false;
  }
}
