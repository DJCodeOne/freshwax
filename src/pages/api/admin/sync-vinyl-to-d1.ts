// src/pages/api/admin/sync-vinyl-to-d1.ts
// One-time migration: Sync existing Firebase vinyl listings to D1

import type { APIRoute } from 'astro';
import { saQueryCollection } from '../../../lib/firebase-service-account';

export const prerender = false;

// Get service account key from environment
function getServiceAccountKey(env: any): string | null {
  let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY ||
                          import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountKey) {
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (clientEmail && privateKey) {
      serviceAccountKey = JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        private_key_id: 'auto',
        private_key: privateKey.replace(/\\n/g, '\n'),
        client_email: clientEmail,
        client_id: 'auto',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
      });
    }
  }

  return serviceAccountKey || null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env || {};
  const db = env.DB;

  if (!db) {
    return new Response(JSON.stringify({ success: false, error: 'D1 not available' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Simple admin check via header
  const adminKey = request.headers.get('X-Admin-Key');
  const expectedKey = env.ADMIN_KEY || import.meta.env.ADMIN_KEY;

  if (!adminKey || adminKey !== expectedKey) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Firebase not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[sync-vinyl-to-d1] Fetching listings from Firebase...');

    // Fetch all vinyl listings from Firebase
    const listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
      limit: 500
    });

    console.log(`[sync-vinyl-to-d1] Found ${listings.length} listings in Firebase`);

    let synced = 0;
    let errors = 0;

    for (const listing of listings) {
      try {
        // Parse tracks and images
        const images = Array.isArray(listing.images) ? listing.images : [];
        const tracks = Array.isArray(listing.tracks) ? listing.tracks : [];

        await db.prepare(`
          INSERT INTO vinyl_listings (
            id, seller_id, seller_name, title, artist, label, catalog_number,
            format, release_year, genre, media_condition, sleeve_condition, condition_notes,
            price, original_price, discount_percent, shipping_cost,
            deal_type, deal_description, description, images, tracks,
            audio_sample_url, audio_sample_duration, status, featured, deleted,
            views, saves, created_at, updated_at, published_at, sold_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            seller_id = excluded.seller_id,
            seller_name = excluded.seller_name,
            title = excluded.title,
            artist = excluded.artist,
            label = excluded.label,
            catalog_number = excluded.catalog_number,
            format = excluded.format,
            release_year = excluded.release_year,
            genre = excluded.genre,
            media_condition = excluded.media_condition,
            sleeve_condition = excluded.sleeve_condition,
            condition_notes = excluded.condition_notes,
            price = excluded.price,
            original_price = excluded.original_price,
            discount_percent = excluded.discount_percent,
            shipping_cost = excluded.shipping_cost,
            deal_type = excluded.deal_type,
            deal_description = excluded.deal_description,
            description = excluded.description,
            images = excluded.images,
            tracks = excluded.tracks,
            audio_sample_url = excluded.audio_sample_url,
            audio_sample_duration = excluded.audio_sample_duration,
            status = excluded.status,
            featured = excluded.featured,
            deleted = excluded.deleted,
            views = excluded.views,
            saves = excluded.saves,
            updated_at = excluded.updated_at,
            published_at = excluded.published_at,
            sold_at = excluded.sold_at,
            deleted_at = excluded.deleted_at
        `).bind(
          listing.id,
          listing.sellerId || '',
          listing.sellerName || 'Unknown Seller',
          listing.title || 'Untitled',
          listing.artist || 'Unknown Artist',
          listing.label || null,
          listing.catalogNumber || null,
          listing.format || 'LP',
          listing.releaseYear || null,
          listing.genre || null,
          listing.mediaCondition || 'VG+',
          listing.sleeveCondition || 'VG+',
          listing.conditionNotes || null,
          listing.price || 0,
          listing.originalPrice || listing.price || 0,
          listing.discountPercent || 0,
          listing.shippingCost || 0,
          listing.dealType || 'none',
          listing.dealDescription || null,
          listing.description || null,
          JSON.stringify(images),
          JSON.stringify(tracks),
          listing.audioSampleUrl || null,
          listing.audioSampleDuration || null,
          listing.status || 'draft',
          listing.featured ? 1 : 0,
          listing.deleted ? 1 : 0,
          listing.views || 0,
          listing.saves || 0,
          listing.createdAt || new Date().toISOString(),
          listing.updatedAt || new Date().toISOString(),
          listing.publishedAt || null,
          listing.soldAt || null,
          listing.deletedAt || null
        ).run();

        synced++;
        console.log(`[sync-vinyl-to-d1] Synced: ${listing.id} - ${listing.title}`);
      } catch (e) {
        errors++;
        console.error(`[sync-vinyl-to-d1] Error syncing ${listing.id}:`, e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Synced ${synced} listings to D1`,
      total: listings.length,
      synced,
      errors
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[sync-vinyl-to-d1] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Migration failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
