// src/lib/d1-catalog.ts
// D1 database operations for releases, DJ mixes, merch, and livestream slots
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

// Extract URL from image (can be string or object with url property)
function extractImageUrl(img: any): string | null {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (typeof img === 'object' && img.url) return img.url;
  return null;
}

// Convert Firebase merch document to D1 row
export function merchToD1Row(id: string, doc: any): Partial<D1Merch> {
  // Extract image URL - handle both string and object formats
  let imageUrl = extractImageUrl(doc.imageUrl) || extractImageUrl(doc.image);
  if (!imageUrl && doc.images && Array.isArray(doc.images)) {
    imageUrl = extractImageUrl(doc.images[0]);
  }

  return {
    id,
    name: doc.name || doc.title || 'Untitled',
    type: doc.type || doc.category || null,
    price: doc.price || 0,
    stock: doc.stock || doc.quantity || 0,
    published: (doc.published ?? doc.active ?? true) ? 1 : 0,
    image_url: imageUrl,
    data: JSON.stringify(doc),
    created_at: doc.createdAt || new Date().toISOString(),
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

export async function d1GetAllMixes(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM dj_mixes ORDER BY upload_date DESC`
    ).all();

    return (results || []).map((row: any) => d1RowToMix(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting all mixes:', e);
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
      INSERT INTO merch (id, name, type, price, stock, published, image_url, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      row.id, row.name, row.type, row.price, row.stock, row.published, row.image_url, row.data, row.created_at, row.updated_at
    ).run();

    console.log('[D1] Upserted merch:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error upserting merch:', e);
    return false;
  }
}

// Delete merch from D1
export async function d1DeleteMerch(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare('DELETE FROM merch WHERE id = ?').bind(id).run();
    console.log('[D1] Deleted merch:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error deleting merch:', e);
    return false;
  }
}

// Get merch by supplier ID (for artist dashboards)
export async function d1GetMerchBySupplierId(db: D1Database, supplierId: string): Promise<any[]> {
  try {
    // Query using JSON extraction for supplierId
    const { results } = await db.prepare(
      `SELECT data FROM merch
       WHERE json_extract(data, '$.supplierId') = ?
       ORDER BY created_at DESC`
    ).bind(supplierId).all();

    return (results || []).map((row: any) => d1RowToMerch(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting merch by supplier:', e);
    return [];
  }
}

// Get merch by supplier name (fallback for artist dashboards)
export async function d1GetMerchBySupplierName(db: D1Database, supplierName: string): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM merch
       WHERE json_extract(data, '$.supplierName') = ?
       ORDER BY created_at DESC`
    ).bind(supplierName).all();

    return (results || []).map((row: any) => d1RowToMerch(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting merch by supplier name:', e);
    return [];
  }
}

// =============================================
// COMMENTS
// =============================================

export interface D1Comment {
  id: string;
  item_id: string;
  item_type: 'release' | 'mix';
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  comment: string | null;
  gif_url: string | null;
  approved: number;
  created_at: string;
}

// Get comments for an item (release or mix)
export async function d1GetComments(db: D1Database, itemId: string, itemType: 'release' | 'mix'): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT * FROM comments WHERE item_id = ? AND item_type = ? ORDER BY created_at DESC`
    ).bind(itemId, itemType).all();

    return (results || []).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      avatarUrl: row.avatar_url,
      comment: row.comment || '',
      gifUrl: row.gif_url,
      timestamp: row.created_at,
      createdAt: row.created_at,
      approved: row.approved === 1
    }));
  } catch (e) {
    console.error('[D1] Error getting comments:', e);
    return [];
  }
}

// Add a comment
export async function d1AddComment(db: D1Database, comment: {
  id: string;
  itemId: string;
  itemType: 'release' | 'mix';
  userId: string;
  userName: string;
  avatarUrl?: string;
  comment?: string;
  gifUrl?: string;
}): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO comments (id, item_id, item_type, user_id, user_name, avatar_url, comment, gif_url, approved, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      comment.id,
      comment.itemId,
      comment.itemType,
      comment.userId,
      comment.userName,
      comment.avatarUrl || null,
      comment.comment || null,
      comment.gifUrl || null,
      new Date().toISOString()
    ).run();

    console.log('[D1] Added comment:', comment.id);
    return true;
  } catch (e) {
    console.error('[D1] Error adding comment:', e);
    return false;
  }
}

// Get comment count for an item
export async function d1GetCommentCount(db: D1Database, itemId: string, itemType: 'release' | 'mix'): Promise<number> {
  try {
    const result = await db.prepare(
      `SELECT COUNT(*) as count FROM comments WHERE item_id = ? AND item_type = ?`
    ).bind(itemId, itemType).first();

    return (result as any)?.count || 0;
  } catch (e) {
    console.error('[D1] Error getting comment count:', e);
    return 0;
  }
}

// =============================================
// RATINGS
// =============================================

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

    return {
      average: (row as any).average || 0,
      count: (row as any).count || 0,
      fiveStarCount: (row as any).five_star_count || 0
    };
  } catch (e) {
    console.error('[D1] Error getting ratings:', e);
    return null;
  }
}

// Get user's rating for a release
export async function d1GetUserRating(db: D1Database, releaseId: string, userId: string): Promise<number | null> {
  try {
    const row = await db.prepare(
      `SELECT rating FROM user_ratings WHERE release_id = ? AND user_id = ?`
    ).bind(releaseId, userId).first();

    return row ? (row as any).rating : null;
  } catch (e) {
    console.error('[D1] Error getting user rating:', e);
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

    const existingRating = existingRow ? (existingRow as any).rating : null;

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

    if (existingRating !== null) {
      // Update existing - recalculate
      const currentAvg = (currentRatings as any)?.average || 0;
      const currentCount = (currentRatings as any)?.count || 0;
      const currentFive = (currentRatings as any)?.five_star_count || 0;

      const totalRating = (currentAvg * currentCount) - existingRating + rating;
      newAverage = currentCount > 0 ? totalRating / currentCount : rating;
      newCount = currentCount;
      newFiveStarCount = currentFive - (existingRating === 5 ? 1 : 0) + (rating === 5 ? 1 : 0);
    } else {
      // New rating
      const currentAvg = (currentRatings as any)?.average || 0;
      const currentCount = (currentRatings as any)?.count || 0;
      const currentFive = (currentRatings as any)?.five_star_count || 0;

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

    console.log('[D1] Upserted rating:', releaseId, userId, rating);

    return { average: newAverage, count: newCount, fiveStarCount: newFiveStarCount };
  } catch (e) {
    console.error('[D1] Error upserting rating:', e);
    return null;
  }
}

// Bulk upsert ratings (for migration)
export async function d1BulkUpsertRatings(db: D1Database, releaseId: string, ratingsData: { average: number; count: number; fiveStarCount: number; userRatings?: Record<string, number> }): Promise<boolean> {
  try {
    const now = new Date().toISOString();

    // Upsert aggregate ratings
    await db.prepare(`
      INSERT INTO ratings (release_id, average, count, five_star_count, last_rated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(release_id) DO UPDATE SET
        average = excluded.average,
        count = excluded.count,
        five_star_count = excluded.five_star_count,
        updated_at = excluded.updated_at
    `).bind(releaseId, ratingsData.average, ratingsData.count, ratingsData.fiveStarCount, now, now).run();

    // Upsert individual user ratings if provided
    if (ratingsData.userRatings) {
      for (const [userId, rating] of Object.entries(ratingsData.userRatings)) {
        const id = `${releaseId}_${userId}`;
        await db.prepare(`
          INSERT INTO user_ratings (id, release_id, user_id, rating, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            rating = excluded.rating,
            updated_at = excluded.updated_at
        `).bind(id, releaseId, userId, rating, now, now).run();
      }
    }

    return true;
  } catch (e) {
    console.error('[D1] Error bulk upserting ratings:', e);
    return false;
  }
}

// =============================================
// LIVESTREAM SLOTS
// =============================================

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
export function slotToD1Row(id: string, doc: any): Partial<D1LivestreamSlot> {
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
export function d1RowToSlot(row: D1LivestreamSlot): any {
  try {
    const doc = JSON.parse(row.data);
    doc.id = row.id;
    return doc;
  } catch (e) {
    console.error('[D1] Error parsing slot data:', e);
    return null;
  }
}

// Get all live slots (status = 'live')
export async function d1GetLiveSlots(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM livestream_slots WHERE status = 'live' ORDER BY start_time ASC`
    ).all();

    return (results || []).map((row: any) => d1RowToSlot(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting live slots:', e);
    return [];
  }
}

// Get scheduled slots (for today/upcoming)
export async function d1GetScheduledSlots(db: D1Database, fromTime?: string): Promise<any[]> {
  try {
    const now = fromTime || new Date().toISOString();
    const { results } = await db.prepare(
      `SELECT data FROM livestream_slots
       WHERE status IN ('scheduled', 'in_lobby', 'live')
       AND end_time > ?
       ORDER BY start_time ASC
       LIMIT 50`
    ).bind(now).all();

    return (results || []).map((row: any) => d1RowToSlot(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting scheduled slots:', e);
    return [];
  }
}

// Get slot by ID
export async function d1GetSlotById(db: D1Database, id: string): Promise<any | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM livestream_slots WHERE id = ?`
    ).bind(id).first();

    return row ? d1RowToSlot(row) : null;
  } catch (e) {
    console.error('[D1] Error getting slot:', e);
    return null;
  }
}

// Get slots by DJ
export async function d1GetSlotsByDj(db: D1Database, djId: string): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM livestream_slots WHERE dj_id = ? ORDER BY start_time DESC LIMIT 20`
    ).bind(djId).all();

    return (results || []).map((row: any) => d1RowToSlot(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting slots by DJ:', e);
    return [];
  }
}

// Upsert a slot
export async function d1UpsertSlot(db: D1Database, id: string, doc: any): Promise<boolean> {
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

    console.log('[D1] Upserted slot:', id, row.status);
    return true;
  } catch (e) {
    console.error('[D1] Error upserting slot:', e);
    return false;
  }
}

// Update slot status only (quick update)
export async function d1UpdateSlotStatus(db: D1Database, id: string, status: string, extraData?: any): Promise<boolean> {
  try {
    // First get the current data
    const row = await db.prepare(`SELECT data FROM livestream_slots WHERE id = ?`).bind(id).first();
    if (!row) {
      console.log('[D1] Slot not found for status update:', id);
      return false;
    }

    const doc = JSON.parse((row as any).data);
    doc.status = status;
    if (extraData) {
      Object.assign(doc, extraData);
    }

    await db.prepare(`
      UPDATE livestream_slots
      SET status = ?, data = ?, updated_at = ?
      WHERE id = ?
    `).bind(status, JSON.stringify(doc), new Date().toISOString(), id).run();

    console.log('[D1] Updated slot status:', id, status);
    return true;
  } catch (e) {
    console.error('[D1] Error updating slot status:', e);
    return false;
  }
}

// Delete a slot
export async function d1DeleteSlot(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare(`DELETE FROM livestream_slots WHERE id = ?`).bind(id).run();
    console.log('[D1] Deleted slot:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error deleting slot:', e);
    return false;
  }
}

// Clean up old slots (ended more than 24 hours ago)
export async function d1CleanupOldSlots(db: D1Database): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await db.prepare(`
      DELETE FROM livestream_slots WHERE status IN ('ended', 'cancelled') AND end_time < ?
    `).bind(cutoff).run();

    const deleted = result.meta?.changes || 0;
    if (deleted > 0) {
      console.log('[D1] Cleaned up', deleted, 'old slots');
    }
    return deleted;
  } catch (e) {
    console.error('[D1] Error cleaning up slots:', e);
    return 0;
  }
}

// =============================================
// SALES LEDGER (primary read source)
// Dual-write with Firebase as backup
// =============================================

export interface D1LedgerEntry {
  id: string;
  order_id: string;
  order_number: string;
  timestamp: string;
  year: number;
  month: number;
  day: number;
  customer_id: string | null;
  customer_email: string;
  artist_id: string | null;
  artist_name: string | null;
  submitter_id: string | null;
  submitter_email: string | null;
  subtotal: number;
  shipping: number;
  discount: number;
  gross_total: number;
  stripe_fee: number;
  paypal_fee: number;
  freshwax_fee: number;
  total_fees: number;
  net_revenue: number;
  artist_payout: number;
  artist_payout_status: string;
  payment_method: string;
  payment_id: string | null;
  currency: string;
  item_count: number;
  has_physical: number;
  has_digital: number;
  data: string;
  created_at: string;
  corrected_at: string | null;
}

// Convert ledger entry to D1 row format
export function ledgerToD1Row(entry: any): Partial<D1LedgerEntry> {
  return {
    id: entry.id,
    order_id: entry.orderId,
    order_number: entry.orderNumber,
    timestamp: entry.timestamp,
    year: entry.year,
    month: entry.month,
    day: entry.day,
    customer_id: entry.customerId || null,
    customer_email: entry.customerEmail,
    artist_id: entry.artistId || null,
    artist_name: entry.artistName || null,
    submitter_id: entry.submitterId || null,
    submitter_email: entry.submitterEmail || null,
    subtotal: entry.subtotal || 0,
    shipping: entry.shipping || 0,
    discount: entry.discount || 0,
    gross_total: entry.grossTotal || 0,
    stripe_fee: entry.stripeFee || 0,
    paypal_fee: entry.paypalFee || 0,
    freshwax_fee: entry.freshWaxFee || 0,
    total_fees: entry.totalFees || 0,
    net_revenue: entry.netRevenue || 0,
    artist_payout: entry.artistPayout || 0,
    artist_payout_status: entry.artistPayoutStatus || 'pending',
    payment_method: entry.paymentMethod || 'stripe',
    payment_id: entry.paymentId || null,
    currency: entry.currency || 'GBP',
    item_count: entry.itemCount || entry.items?.length || 0,
    has_physical: entry.hasPhysical ? 1 : 0,
    has_digital: entry.hasDigital ? 1 : 0,
    data: JSON.stringify(entry),
    corrected_at: entry.correctedAt || null
  };
}

// Convert D1 row to ledger entry format
export function d1RowToLedger(row: D1LedgerEntry): any {
  try {
    const doc = JSON.parse(row.data);
    doc.id = row.id;
    // Ensure key fields are present
    doc.artistPayoutStatus = row.artist_payout_status;
    doc.artistPayout = row.artist_payout;
    return doc;
  } catch (e) {
    console.error('[D1] Error parsing ledger data:', e);
    return null;
  }
}

// Insert a new ledger entry
export async function d1InsertLedgerEntry(db: D1Database, id: string, entry: any): Promise<boolean> {
  try {
    const row = ledgerToD1Row({ ...entry, id });

    await db.prepare(`
      INSERT INTO sales_ledger (
        id, order_id, order_number, timestamp, year, month, day,
        customer_id, customer_email, artist_id, artist_name, submitter_id, submitter_email,
        subtotal, shipping, discount, gross_total,
        stripe_fee, paypal_fee, freshwax_fee, total_fees, net_revenue,
        artist_payout, artist_payout_status,
        payment_method, payment_id, currency,
        item_count, has_physical, has_digital, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id, row.order_id, row.order_number, row.timestamp, row.year, row.month, row.day,
      row.customer_id, row.customer_email, row.artist_id, row.artist_name, row.submitter_id, row.submitter_email,
      row.subtotal, row.shipping, row.discount, row.gross_total,
      row.stripe_fee, row.paypal_fee, row.freshwax_fee, row.total_fees, row.net_revenue,
      row.artist_payout, row.artist_payout_status,
      row.payment_method, row.payment_id, row.currency,
      row.item_count, row.has_physical, row.has_digital, row.data
    ).run();

    console.log('[D1] Inserted ledger entry:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error inserting ledger entry:', e);
    return false;
  }
}

// Update ledger entry (for corrections)
export async function d1UpdateLedgerEntry(db: D1Database, id: string, updates: any): Promise<boolean> {
  try {
    // Build update query dynamically based on what fields are provided
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.artistPayoutStatus !== undefined) {
      fields.push('artist_payout_status = ?');
      values.push(updates.artistPayoutStatus);
    }
    if (updates.artistPayout !== undefined) {
      fields.push('artist_payout = ?');
      values.push(updates.artistPayout);
    }
    if (updates.artistId !== undefined) {
      fields.push('artist_id = ?');
      values.push(updates.artistId);
    }
    if (updates.artistName !== undefined) {
      fields.push('artist_name = ?');
      values.push(updates.artistName);
    }
    if (updates.submitterId !== undefined) {
      fields.push('submitter_id = ?');
      values.push(updates.submitterId);
    }
    if (updates.submitterEmail !== undefined) {
      fields.push('submitter_email = ?');
      values.push(updates.submitterEmail);
    }
    if (updates.grossTotal !== undefined) {
      fields.push('gross_total = ?');
      values.push(updates.grossTotal);
    }
    if (updates.netRevenue !== undefined) {
      fields.push('net_revenue = ?');
      values.push(updates.netRevenue);
    }
    if (updates.totalFees !== undefined) {
      fields.push('total_fees = ?');
      values.push(updates.totalFees);
    }

    if (fields.length === 0) {
      return true; // Nothing to update
    }

    fields.push('corrected_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await db.prepare(`
      UPDATE sales_ledger SET ${fields.join(', ')} WHERE id = ?
    `).bind(...values).run();

    console.log('[D1] Updated ledger entry:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error updating ledger entry:', e);
    return false;
  }
}

// Get all ledger entries (with optional filters)
export async function d1GetLedgerEntries(db: D1Database, options: {
  year?: number;
  month?: number;
  artistId?: string;
  payoutStatus?: string;
  limit?: number;
} = {}): Promise<any[]> {
  try {
    let query = 'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE 1=1';
    const params: any[] = [];

    if (options.year) {
      query += ' AND year = ?';
      params.push(options.year);
    }
    if (options.month) {
      query += ' AND month = ?';
      params.push(options.month);
    }
    if (options.artistId) {
      query += ' AND (artist_id = ? OR submitter_id = ?)';
      params.push(options.artistId, options.artistId);
    }
    if (options.payoutStatus) {
      query += ' AND artist_payout_status = ?';
      params.push(options.payoutStatus);
    }

    query += ' ORDER BY timestamp DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = db.prepare(query);
    const { results } = params.length > 0
      ? await stmt.bind(...params).all()
      : await stmt.all();

    return (results || []).map((row: any) => d1RowToLedger(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting ledger entries:', e);
    return [];
  }
}

// Get ledger entry by ID
export async function d1GetLedgerEntryById(db: D1Database, id: string): Promise<any | null> {
  try {
    const row = await db.prepare(
      'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE id = ?'
    ).bind(id).first();

    return row ? d1RowToLedger(row as D1LedgerEntry) : null;
  } catch (e) {
    console.error('[D1] Error getting ledger entry:', e);
    return null;
  }
}

// Get ledger entries by order ID
export async function d1GetLedgerEntriesByOrder(db: D1Database, orderId: string): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE order_id = ? ORDER BY timestamp DESC'
    ).bind(orderId).all();

    return (results || []).map((row: any) => d1RowToLedger(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting ledger entries by order:', e);
    return [];
  }
}

// Get ledger entries for an artist
export async function d1GetLedgerEntriesByArtist(db: D1Database, artistId: string): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE artist_id = ? OR submitter_id = ? ORDER BY timestamp DESC'
    ).bind(artistId, artistId).all();

    return (results || []).map((row: any) => d1RowToLedger(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting ledger entries by artist:', e);
    return [];
  }
}

// Get ledger totals (aggregated)
export async function d1GetLedgerTotals(db: D1Database, options: {
  year?: number;
  month?: number;
  artistId?: string;
} = {}): Promise<{
  orders: number;
  grossRevenue: number;
  netRevenue: number;
  totalFees: number;
  pendingPayouts: number;
  paidPayouts: number;
}> {
  try {
    let query = `
      SELECT
        COUNT(*) as orders,
        COALESCE(SUM(gross_total), 0) as gross_revenue,
        COALESCE(SUM(net_revenue), 0) as net_revenue,
        COALESCE(SUM(total_fees), 0) as total_fees,
        COALESCE(SUM(CASE WHEN artist_payout_status = 'pending' THEN artist_payout ELSE 0 END), 0) as pending_payouts,
        COALESCE(SUM(CASE WHEN artist_payout_status = 'paid' THEN artist_payout ELSE 0 END), 0) as paid_payouts
      FROM sales_ledger WHERE 1=1
    `;
    const params: any[] = [];

    if (options.year) {
      query += ' AND year = ?';
      params.push(options.year);
    }
    if (options.month) {
      query += ' AND month = ?';
      params.push(options.month);
    }
    if (options.artistId) {
      query += ' AND (artist_id = ? OR submitter_id = ?)';
      params.push(options.artistId, options.artistId);
    }

    const stmt = db.prepare(query);
    const row = params.length > 0
      ? await stmt.bind(...params).first()
      : await stmt.first();

    return {
      orders: (row as any)?.orders || 0,
      grossRevenue: (row as any)?.gross_revenue || 0,
      netRevenue: (row as any)?.net_revenue || 0,
      totalFees: (row as any)?.total_fees || 0,
      pendingPayouts: (row as any)?.pending_payouts || 0,
      paidPayouts: (row as any)?.paid_payouts || 0
    };
  } catch (e) {
    console.error('[D1] Error getting ledger totals:', e);
    return { orders: 0, grossRevenue: 0, netRevenue: 0, totalFees: 0, pendingPayouts: 0, paidPayouts: 0 };
  }
}

// Delete ledger entry (admin only)
export async function d1DeleteLedgerEntry(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare('DELETE FROM sales_ledger WHERE id = ?').bind(id).run();
    console.log('[D1] Deleted ledger entry:', id);
    return true;
  } catch (e) {
    console.error('[D1] Error deleting ledger entry:', e);
    return false;
  }
}

// =============================================
// VINYL SELLERS (settings for vinyl crate sellers)
// D1 Primary, Firebase backup
// =============================================

export interface D1VinylSeller {
  id: string;  // user_id
  store_name: string | null;
  location: string | null;
  description: string | null;
  discogs_url: string | null;
  shipping_single: number;
  shipping_additional: number;
  ships_international: number;
  shipping_europe: number;
  shipping_europe_additional: number;
  shipping_worldwide: number;
  shipping_worldwide_additional: number;
  data: string;
  created_at: string;
  updated_at: string;
}

// Convert vinyl seller document to D1 row
export function vinylSellerToD1Row(id: string, doc: any): Partial<D1VinylSeller> {
  return {
    id,
    store_name: doc.storeName || null,
    location: doc.location || null,
    description: doc.description || null,
    discogs_url: doc.discogsUrl || null,
    shipping_single: doc.shippingSingle || 0,
    shipping_additional: doc.shippingAdditional || 0,
    ships_international: doc.shipsInternational ? 1 : 0,
    shipping_europe: doc.shippingEurope || 0,
    shipping_europe_additional: doc.shippingEuropeAdditional || 0,
    shipping_worldwide: doc.shippingWorldwide || 0,
    shipping_worldwide_additional: doc.shippingWorldwideAdditional || 0,
    data: JSON.stringify(doc),
    updated_at: new Date().toISOString()
  };
}

// Convert D1 row back to vinyl seller document
export function d1RowToVinylSeller(row: D1VinylSeller): any {
  try {
    const doc = JSON.parse(row.data);
    doc.id = row.id;
    doc.userId = row.id;
    return doc;
  } catch (e) {
    console.error('[D1] Error parsing vinyl seller data:', e);
    return null;
  }
}

// Get vinyl seller settings by user ID
export async function d1GetVinylSeller(db: D1Database, userId: string): Promise<any | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM vinyl_sellers WHERE id = ?`
    ).bind(userId).first();

    return row ? d1RowToVinylSeller(row as D1VinylSeller) : null;
  } catch (e) {
    console.error('[D1] Error getting vinyl seller:', e);
    return null;
  }
}

// Upsert vinyl seller settings
export async function d1UpsertVinylSeller(db: D1Database, userId: string, doc: any): Promise<boolean> {
  try {
    const row = vinylSellerToD1Row(userId, doc);

    await db.prepare(`
      INSERT INTO vinyl_sellers (
        id, store_name, location, description, discogs_url,
        shipping_single, shipping_additional, ships_international,
        shipping_europe, shipping_europe_additional,
        shipping_worldwide, shipping_worldwide_additional,
        data, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        store_name = excluded.store_name,
        location = excluded.location,
        description = excluded.description,
        discogs_url = excluded.discogs_url,
        shipping_single = excluded.shipping_single,
        shipping_additional = excluded.shipping_additional,
        ships_international = excluded.ships_international,
        shipping_europe = excluded.shipping_europe,
        shipping_europe_additional = excluded.shipping_europe_additional,
        shipping_worldwide = excluded.shipping_worldwide,
        shipping_worldwide_additional = excluded.shipping_worldwide_additional,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).bind(
      row.id, row.store_name, row.location, row.description, row.discogs_url,
      row.shipping_single, row.shipping_additional, row.ships_international,
      row.shipping_europe, row.shipping_europe_additional,
      row.shipping_worldwide, row.shipping_worldwide_additional,
      row.data, doc.createdAt || new Date().toISOString(), row.updated_at
    ).run();

    console.log('[D1] Upserted vinyl seller:', userId);
    return true;
  } catch (e) {
    console.error('[D1] Error upserting vinyl seller:', e);
    return false;
  }
}

// Delete vinyl seller settings
export async function d1DeleteVinylSeller(db: D1Database, userId: string): Promise<boolean> {
  try {
    await db.prepare('DELETE FROM vinyl_sellers WHERE id = ?').bind(userId).run();
    console.log('[D1] Deleted vinyl seller:', userId);
    return true;
  } catch (e) {
    console.error('[D1] Error deleting vinyl seller:', e);
    return false;
  }
}

// Get all vinyl sellers (for admin)
export async function d1GetAllVinylSellers(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM vinyl_sellers ORDER BY updated_at DESC`
    ).all();

    return (results || []).map((row: any) => d1RowToVinylSeller(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting all vinyl sellers:', e);
    return [];
  }
}

// Get next available collection number
export async function d1GetNextCollectionNumber(db: D1Database): Promise<number> {
  try {
    const result = await db.prepare(
      `SELECT MAX(json_extract(data, '$.collectionNumber')) as max_num FROM vinyl_sellers`
    ).first();

    const maxNum = (result as any)?.max_num || 0;
    return maxNum + 1;
  } catch (e) {
    console.error('[D1] Error getting next collection number:', e);
    return 1; // Default to 1 if error
  }
}

// Get vinyl seller by collection number (for public crates page)
export async function d1GetVinylSellerByCollection(db: D1Database, collectionNumber: number): Promise<any | null> {
  try {
    const row = await db.prepare(
      `SELECT data FROM vinyl_sellers WHERE json_extract(data, '$.collectionNumber') = ?`
    ).bind(collectionNumber).first();

    return row ? d1RowToVinylSeller(row as D1VinylSeller) : null;
  } catch (e) {
    console.error('[D1] Error getting vinyl seller by collection:', e);
    return null;
  }
}

// Get all vinyl sellers with collection numbers (for public crates sidebar)
export async function d1GetAllCollections(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare(
      `SELECT data FROM vinyl_sellers
       WHERE json_extract(data, '$.collectionNumber') IS NOT NULL
       ORDER BY json_extract(data, '$.collectionNumber') ASC`
    ).all();

    return (results || []).map((row: any) => d1RowToVinylSeller(row)).filter(Boolean);
  } catch (e) {
    console.error('[D1] Error getting all collections:', e);
    return [];
  }
}
