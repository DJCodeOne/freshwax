// src/pages/api/admin/sync-vinyl-to-d1.ts
// One-time migration: Sync existing Firebase vinyl listings to D1

import type { APIRoute } from 'astro';
import { saQueryCollection, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('[sync-vinyl-to-d1]');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`sync-vinyl-to-d1:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env || {};
  const db = env.DB;

  if (!db) {
    return ApiErrors.serverError('D1 not available');
  }

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Firebase not configured');
    }

    log.info('[sync-vinyl-to-d1] Fetching listings from Firebase...');

    // Fetch all vinyl listings from Firebase
    const listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
      limit: 500
    });

    log.info(`[sync-vinyl-to-d1] Found ${listings.length} listings in Firebase`);

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
        log.info(`[sync-vinyl-to-d1] Synced: ${listing.id} - ${listing.title}`);
      } catch (e: unknown) {
        errors++;
        log.error(`[sync-vinyl-to-d1] Error syncing ${listing.id}:`, e);
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

  } catch (error: unknown) {
    log.error('[sync-vinyl-to-d1] Error:', error);
    return ApiErrors.serverError('Migration failed');
  }
};
