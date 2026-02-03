/**
 * Vinyl API - Cloudflare Worker
 * Handles all vinyl/crates marketplace operations
 * D1 primary storage, Firebase backup, R2 for files
 */

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  CACHE: KVNamespace;
  R2_PUBLIC_DOMAIN: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  ENVIRONMENT: string;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// JSON response helper
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Error response helper
function error(message: string, status = 400): Response {
  return json({ success: false, error: message }, status);
}

// Generate unique listing ID
function generateListingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `vl_${timestamp}${random}`;
}

// Rate limiting
async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const windowKey = `rate:${key}:${Math.floor(now / windowMs)}`;

  const current = parseInt(await kv.get(windowKey) || '0');

  if (current >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  await kv.put(windowKey, String(current + 1), { expirationTtl: Math.ceil(windowMs / 1000) });
  return { allowed: true, remaining: maxRequests - current - 1 };
}

// Verify Firebase ID token (simplified - in production use proper JWT verification)
async function verifyAuth(request: Request, env: Env): Promise<{ userId: string } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);

  try {
    // Verify token with Firebase
    const verifyUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`;
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    const data = await response.json() as any;
    if (data.users && data.users[0]) {
      return { userId: data.users[0].localId };
    }
  } catch (e) {
    console.error('Auth verification failed:', e);
  }

  return null;
}

// =============================================
// D1 OPERATIONS
// =============================================

interface VinylListing {
  id: string;
  seller_id: string;
  seller_name: string;
  title: string;
  artist: string;
  label?: string;
  catalog_number?: string;
  format: string;
  release_year?: number;
  genre?: string;
  media_condition: string;
  sleeve_condition: string;
  condition_notes?: string;
  price: number;
  original_price?: number;
  discount_percent: number;
  shipping_cost: number;
  deal_type: string;
  deal_description?: string;
  description?: string;
  images: string;
  tracks: string;
  audio_sample_url?: string;
  audio_sample_duration?: number;
  status: string;
  featured: number;
  deleted: number;
  views: number;
  saves: number;
  created_at: string;
  updated_at: string;
  published_at?: string;
  sold_at?: string;
  deleted_at?: string;
}

// Convert D1 row to API response format
function rowToListing(row: VinylListing): any {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    title: row.title,
    artist: row.artist,
    label: row.label,
    catalogNumber: row.catalog_number,
    format: row.format,
    releaseYear: row.release_year,
    genre: row.genre,
    mediaCondition: row.media_condition,
    sleeveCondition: row.sleeve_condition,
    conditionNotes: row.condition_notes,
    price: row.price,
    originalPrice: row.original_price,
    discountPercent: row.discount_percent,
    shippingCost: row.shipping_cost,
    dealType: row.deal_type,
    dealDescription: row.deal_description,
    description: row.description,
    images: JSON.parse(row.images || '[]'),
    tracks: JSON.parse(row.tracks || '[]'),
    audioSampleUrl: row.audio_sample_url,
    audioSampleDuration: row.audio_sample_duration,
    status: row.status,
    featured: row.featured === 1,
    views: row.views,
    saves: row.saves,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

// Get all published listings
async function getPublishedListings(
  db: D1Database,
  options: { sellerId?: string; genre?: string; limit?: number; offset?: number }
): Promise<any[]> {
  let query = `SELECT * FROM vinyl_listings WHERE status = 'published' AND deleted = 0`;
  const params: any[] = [];

  if (options.sellerId) {
    query += ` AND seller_id = ?`;
    params.push(options.sellerId);
  }

  if (options.genre && options.genre !== 'all') {
    query += ` AND genre = ?`;
    params.push(options.genre);
  }

  query += ` ORDER BY published_at DESC`;

  if (options.limit) {
    query += ` LIMIT ?`;
    params.push(options.limit);
  }

  if (options.offset) {
    query += ` OFFSET ?`;
    params.push(options.offset);
  }

  const stmt = params.length > 0 ? db.prepare(query).bind(...params) : db.prepare(query);
  const { results } = await stmt.all();

  return (results || []).map((row: any) => rowToListing(row));
}

// Get deals (listings with discounts)
async function getDeals(db: D1Database, limit = 50): Promise<any[]> {
  const { results } = await db.prepare(`
    SELECT * FROM vinyl_listings
    WHERE status = 'published' AND deleted = 0 AND discount_percent > 0
    ORDER BY discount_percent DESC, published_at DESC
    LIMIT ?
  `).bind(limit).all();

  return (results || []).map((row: any) => rowToListing(row));
}

// Get single listing
async function getListing(db: D1Database, id: string): Promise<any | null> {
  const row = await db.prepare(`
    SELECT * FROM vinyl_listings WHERE id = ?
  `).bind(id).first();

  return row ? rowToListing(row as VinylListing) : null;
}

// Get seller's listings
async function getSellerListings(db: D1Database, sellerId: string): Promise<any[]> {
  const { results } = await db.prepare(`
    SELECT * FROM vinyl_listings WHERE seller_id = ? AND deleted = 0
    ORDER BY created_at DESC
  `).bind(sellerId).all();

  return (results || []).map((row: any) => rowToListing(row));
}

// Create listing
async function createListing(db: D1Database, data: any): Promise<string> {
  const id = generateListingId();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO vinyl_listings (
      id, seller_id, seller_name, title, artist, label, catalog_number,
      format, release_year, genre, media_condition, sleeve_condition, condition_notes,
      price, original_price, discount_percent, shipping_cost,
      deal_type, deal_description, description, images, tracks,
      audio_sample_url, audio_sample_duration, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.sellerId,
    data.sellerName || 'Unknown Seller',
    data.title,
    data.artist,
    data.label || null,
    data.catalogNumber || null,
    data.format || 'LP',
    data.releaseYear || null,
    data.genre || null,
    data.mediaCondition,
    data.sleeveCondition,
    data.conditionNotes || null,
    data.price,
    data.originalPrice || data.price,
    data.discountPercent || 0,
    data.shippingCost || 0,
    data.dealType || 'none',
    data.dealDescription || null,
    data.description || null,
    JSON.stringify(data.images || []),
    JSON.stringify(data.tracks || []),
    data.audioSampleUrl || null,
    data.audioSampleDuration || null,
    'draft',
    now,
    now
  ).run();

  return id;
}

// Update listing
async function updateListing(db: D1Database, id: string, data: any): Promise<boolean> {
  const updates: string[] = ['updated_at = ?'];
  const values: any[] = [new Date().toISOString()];

  const fields: Record<string, string> = {
    title: 'title',
    artist: 'artist',
    label: 'label',
    catalogNumber: 'catalog_number',
    format: 'format',
    releaseYear: 'release_year',
    genre: 'genre',
    mediaCondition: 'media_condition',
    sleeveCondition: 'sleeve_condition',
    conditionNotes: 'condition_notes',
    price: 'price',
    originalPrice: 'original_price',
    discountPercent: 'discount_percent',
    shippingCost: 'shipping_cost',
    dealType: 'deal_type',
    dealDescription: 'deal_description',
    description: 'description',
    audioSampleUrl: 'audio_sample_url',
    audioSampleDuration: 'audio_sample_duration',
  };

  for (const [jsKey, dbKey] of Object.entries(fields)) {
    if (data[jsKey] !== undefined) {
      updates.push(`${dbKey} = ?`);
      values.push(data[jsKey]);
    }
  }

  // Handle JSON fields
  if (data.images !== undefined) {
    updates.push('images = ?');
    values.push(JSON.stringify(data.images));
  }
  if (data.tracks !== undefined) {
    updates.push('tracks = ?');
    values.push(JSON.stringify(data.tracks));
  }

  values.push(id);

  await db.prepare(`
    UPDATE vinyl_listings SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values).run();

  return true;
}

// Publish listing
async function publishListing(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE vinyl_listings SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?
  `).bind(now, now, id).run();
  return true;
}

// Unpublish listing
async function unpublishListing(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE vinyl_listings SET status = 'draft', updated_at = ? WHERE id = ?
  `).bind(now, id).run();
  return true;
}

// Soft delete listing
async function deleteListing(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE vinyl_listings SET status = 'removed', deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?
  `).bind(now, now, id).run();
  return true;
}

// Mark as sold
async function markAsSold(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE vinyl_listings SET status = 'sold', sold_at = ?, updated_at = ? WHERE id = ?
  `).bind(now, now, id).run();
  return true;
}

// Increment views
async function incrementViews(db: D1Database, id: string): Promise<void> {
  await db.prepare(`
    UPDATE vinyl_listings SET views = views + 1 WHERE id = ?
  `).bind(id).run();
}

// Get unique genres
async function getGenres(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`
    SELECT DISTINCT genre FROM vinyl_listings
    WHERE status = 'published' AND deleted = 0 AND genre IS NOT NULL
    ORDER BY genre
  `).all();

  return (results || []).map((r: any) => r.genre);
}

// =============================================
// FIREBASE SYNC (backup)
// =============================================

async function syncToFirebase(env: Env, id: string, data: any): Promise<void> {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    console.log('Firebase not configured, skipping sync');
    return;
  }

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/vinylListings/${id}?key=${env.FIREBASE_API_KEY}`;

    // Convert to Firestore format
    const firestoreDoc = {
      fields: Object.fromEntries(
        Object.entries(data).map(([key, value]) => {
          if (value === null || value === undefined) {
            return [key, { nullValue: null }];
          }
          if (typeof value === 'string') {
            return [key, { stringValue: value }];
          }
          if (typeof value === 'number') {
            return [key, Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }];
          }
          if (typeof value === 'boolean') {
            return [key, { booleanValue: value }];
          }
          if (Array.isArray(value)) {
            return [key, { arrayValue: { values: value.map(v => ({ stringValue: String(v) })) } }];
          }
          return [key, { stringValue: JSON.stringify(value) }];
        })
      ),
    };

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDoc),
    });

    console.log(`Synced listing ${id} to Firebase`);
  } catch (e) {
    console.error('Firebase sync failed:', e);
  }
}

// =============================================
// R2 UPLOAD HANDLERS
// =============================================

async function handleImageUpload(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get('file') as File;
  const sellerId = formData.get('sellerId') as string;
  const listingId = formData.get('listingId') as string || `temp_${Date.now()}`;
  const imageIndex = parseInt(formData.get('imageIndex') as string || '0');

  if (!file || !sellerId) {
    return error('File and sellerId required');
  }

  // Validate file type
  const validTypes = ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
  if (!validTypes.includes(file.type)) {
    return error('Invalid file type. Only WebP, PNG, JPEG, and GIF allowed.');
  }

  // Validate size (10MB max)
  if (file.size > 10 * 1024 * 1024) {
    return error('File too large. Maximum 10MB allowed.');
  }

  const buffer = await file.arrayBuffer();
  const timestamp = Date.now();
  const filename = `${listingId}_${imageIndex}_${timestamp}.webp`;
  const key = `vinyl/${sellerId}/${filename}`;

  // Upload to R2
  await env.R2.put(key, buffer, {
    httpMetadata: {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000',
    },
  });

  const publicUrl = `${env.R2_PUBLIC_DOMAIN}/${key}`;

  return json({
    success: true,
    url: publicUrl,
    key,
    size: file.size,
    imageIndex,
  });
}

async function handleAudioUpload(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get('file') as File;
  const sellerId = formData.get('sellerId') as string;
  const listingId = formData.get('listingId') as string || `temp_${Date.now()}`;
  const trackIndex = parseInt(formData.get('trackIndex') as string || '0');
  const duration = parseFloat(formData.get('duration') as string || '0');

  if (!file || !sellerId) {
    return error('File and sellerId required');
  }

  // Validate file type (MP3 only)
  if (file.type !== 'audio/mpeg' && file.type !== 'audio/mp3') {
    return error('Invalid file type. Only MP3 files allowed.');
  }

  // Validate size (2MB max for 90s at 128kbps)
  if (file.size > 2 * 1024 * 1024) {
    return error('File too large. Maximum 2MB allowed.');
  }

  // Validate duration
  if (duration > 90) {
    return error('Audio too long. Maximum 90 seconds allowed.');
  }

  const buffer = await file.arrayBuffer();
  const timestamp = Date.now();
  const filename = `${listingId}_track${trackIndex}_${timestamp}.mp3`;
  const key = `vinyl/${sellerId}/audio/${filename}`;

  // Upload to R2
  await env.R2.put(key, buffer, {
    httpMetadata: {
      contentType: 'audio/mpeg',
      cacheControl: 'public, max-age=31536000',
    },
  });

  const publicUrl = `${env.R2_PUBLIC_DOMAIN}/${key}`;

  return json({
    success: true,
    url: publicUrl,
    key,
    size: file.size,
    duration: Math.round(duration),
    trackIndex,
  });
}

// =============================================
// ROUTE HANDLERS
// =============================================

// GET /listings - Public listing browse
async function handleGetListings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'listings';
  const sellerId = url.searchParams.get('collection') || url.searchParams.get('sellerId');
  const genre = url.searchParams.get('genre');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const id = url.searchParams.get('id');

  try {
    // Single listing
    if (type === 'single' && id) {
      const listing = await getListing(env.DB, id);
      if (!listing || listing.status !== 'published') {
        return error('Listing not found', 404);
      }
      // Increment views asynchronously
      incrementViews(env.DB, id);
      return json({ success: true, listing });
    }

    // Deals
    if (type === 'deals') {
      const deals = await getDeals(env.DB, limit);
      return json({ success: true, listings: deals, count: deals.length });
    }

    // Collections (sellers)
    if (type === 'collections') {
      const { results } = await env.DB.prepare(`
        SELECT id, store_name, location, description, data FROM vinyl_sellers
        WHERE store_name IS NOT NULL
        ORDER BY store_name
      `).all();

      const collections = (results || []).map((row: any) => {
        const data = JSON.parse(row.data || '{}');
        return {
          id: row.id,
          storeName: row.store_name || data.storeName,
          location: row.location || data.location,
          description: row.description || data.description,
          collectionNumber: data.collectionNumber,
        };
      });

      return json({ success: true, collections });
    }

    // Genres
    if (type === 'genres') {
      const genres = await getGenres(env.DB);
      return json({ success: true, genres });
    }

    // Default: published listings
    const listings = await getPublishedListings(env.DB, { sellerId, genre, limit, offset });
    const genres = await getGenres(env.DB);

    return json({
      success: true,
      listings,
      count: listings.length,
      genres,
    });
  } catch (e) {
    console.error('Error fetching listings:', e);
    return error('Failed to fetch listings', 500);
  }
}

// GET /seller/:sellerId/listings - Seller's own listings (auth required)
async function handleGetSellerListings(request: Request, env: Env, sellerId: string): Promise<Response> {
  const auth = await verifyAuth(request, env);
  if (!auth || auth.userId !== sellerId) {
    return error('Unauthorized', 401);
  }

  try {
    const listings = await getSellerListings(env.DB, sellerId);
    return json({ success: true, listings, count: listings.length });
  } catch (e) {
    console.error('Error fetching seller listings:', e);
    return error('Failed to fetch listings', 500);
  }
}

// POST /listings - Create listing (auth required)
async function handleCreateListing(request: Request, env: Env): Promise<Response> {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return error('Unauthorized', 401);
  }

  // Rate limit
  const rateCheck = await checkRateLimit(env.CACHE, `create:${auth.userId}`, 20, 3600000);
  if (!rateCheck.allowed) {
    return error('Rate limit exceeded', 429);
  }

  try {
    const body = await request.json() as any;

    // Validate required fields
    if (!body.title || !body.artist || !body.mediaCondition || !body.sleeveCondition || !body.price) {
      return error('Missing required fields: title, artist, mediaCondition, sleeveCondition, price');
    }

    // Ensure seller matches authenticated user
    if (body.sellerId !== auth.userId) {
      return error('Seller ID must match authenticated user', 403);
    }

    const id = await createListing(env.DB, body);

    // Get the created listing
    const listing = await getListing(env.DB, id);

    // Sync to Firebase (async, don't wait)
    syncToFirebase(env, id, listing);

    return json({ success: true, listing, listingId: id }, 201);
  } catch (e) {
    console.error('Error creating listing:', e);
    return error('Failed to create listing', 500);
  }
}

// PUT /listings/:id - Update listing (auth required)
async function handleUpdateListing(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return error('Unauthorized', 401);
  }

  try {
    // Verify ownership
    const existing = await getListing(env.DB, id);
    if (!existing) {
      return error('Listing not found', 404);
    }
    if (existing.sellerId !== auth.userId) {
      return error('Not authorized to edit this listing', 403);
    }

    const body = await request.json() as any;
    await updateListing(env.DB, id, body);

    const updated = await getListing(env.DB, id);

    // Sync to Firebase
    syncToFirebase(env, id, updated);

    return json({ success: true, listing: updated });
  } catch (e) {
    console.error('Error updating listing:', e);
    return error('Failed to update listing', 500);
  }
}

// POST /listings/:id/publish - Publish listing
async function handlePublishListing(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return error('Unauthorized', 401);
  }

  try {
    const existing = await getListing(env.DB, id);
    if (!existing) {
      return error('Listing not found', 404);
    }
    if (existing.sellerId !== auth.userId) {
      return error('Not authorized', 403);
    }

    // Require at least one image
    if (!existing.images || existing.images.length === 0) {
      return error('At least one image required to publish');
    }

    await publishListing(env.DB, id);
    const updated = await getListing(env.DB, id);

    // Sync to Firebase
    syncToFirebase(env, id, updated);

    return json({ success: true, message: 'Listing is now live!', listing: updated });
  } catch (e) {
    console.error('Error publishing listing:', e);
    return error('Failed to publish listing', 500);
  }
}

// POST /listings/:id/unpublish - Unpublish listing
async function handleUnpublishListing(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return error('Unauthorized', 401);
  }

  try {
    const existing = await getListing(env.DB, id);
    if (!existing || existing.sellerId !== auth.userId) {
      return error('Not authorized', 403);
    }

    await unpublishListing(env.DB, id);
    const updated = await getListing(env.DB, id);

    syncToFirebase(env, id, updated);

    return json({ success: true, message: 'Listing unpublished', listing: updated });
  } catch (e) {
    console.error('Error unpublishing listing:', e);
    return error('Failed to unpublish listing', 500);
  }
}

// DELETE /listings/:id - Delete listing
async function handleDeleteListing(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return error('Unauthorized', 401);
  }

  try {
    const existing = await getListing(env.DB, id);
    if (!existing || existing.sellerId !== auth.userId) {
      return error('Not authorized', 403);
    }

    await deleteListing(env.DB, id);

    // Sync deletion to Firebase
    syncToFirebase(env, id, { ...existing, status: 'removed', deleted: true, deletedAt: new Date().toISOString() });

    return json({ success: true, message: 'Listing deleted' });
  } catch (e) {
    console.error('Error deleting listing:', e);
    return error('Failed to delete listing', 500);
  }
}

// =============================================
// MAIN ROUTER
// =============================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Public endpoints
      if (path === '/listings' || path === '/api/vinyl/public') {
        if (method === 'GET') {
          return handleGetListings(request, env);
        }
        if (method === 'POST') {
          return handleCreateListing(request, env);
        }
      }

      // Single listing operations
      const listingMatch = path.match(/^\/listings\/([^\/]+)$/);
      if (listingMatch) {
        const id = listingMatch[1];
        if (method === 'GET') {
          const listing = await getListing(env.DB, id);
          if (!listing) return error('Listing not found', 404);
          incrementViews(env.DB, id);
          return json({ success: true, listing });
        }
        if (method === 'PUT') {
          return handleUpdateListing(request, env, id);
        }
        if (method === 'DELETE') {
          return handleDeleteListing(request, env, id);
        }
      }

      // Publish/unpublish
      const publishMatch = path.match(/^\/listings\/([^\/]+)\/(publish|unpublish)$/);
      if (publishMatch && method === 'POST') {
        const id = publishMatch[1];
        const action = publishMatch[2];
        if (action === 'publish') {
          return handlePublishListing(request, env, id);
        }
        return handleUnpublishListing(request, env, id);
      }

      // Seller listings
      const sellerMatch = path.match(/^\/seller\/([^\/]+)\/listings$/);
      if (sellerMatch && method === 'GET') {
        return handleGetSellerListings(request, env, sellerMatch[1]);
      }

      // File uploads
      if (path === '/upload/image' && method === 'POST') {
        const auth = await verifyAuth(request, env);
        if (!auth) return error('Unauthorized', 401);
        return handleImageUpload(request, env);
      }

      if (path === '/upload/audio' && method === 'POST') {
        const auth = await verifyAuth(request, env);
        if (!auth) return error('Unauthorized', 401);
        return handleAudioUpload(request, env);
      }

      // Health check
      if (path === '/health' || path === '/') {
        return json({ status: 'ok', service: 'vinyl-api', timestamp: new Date().toISOString() });
      }

      return error('Not found', 404);
    } catch (e) {
      console.error('Unhandled error:', e);
      return error('Internal server error', 500);
    }
  },
};
