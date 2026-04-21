// src/pages/api/get-orders.ts
// Fetch orders for a customer - uses Firebase REST API
// Optimized: Uses batch fetch for releases to avoid N+1 queries
// SECURITY: Requires authentication - user can only view their own orders
import type { APIRoute } from 'astro';
import { queryCollection, getDocumentsBatch, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('get-orders');

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-orders:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  // SECURITY: Verify the requesting user's identity
  const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);

  if (authError || !verifiedUserId) {
    return ApiErrors.unauthorized(authError || 'Authentication required');
  }

  // User can only fetch their own orders
  const userId = verifiedUserId;

  try {
    log.info('[get-orders] Fetching orders for user:', userId);

    // Query orders filtered by customer.userId (server-side Firestore filter)
    const userOrders = await queryCollection('orders', {
      filters: [{ field: 'customer.userId', op: 'EQUAL', value: userId }],
      limit: 100,
      skipCache: true
    });

    // OPTIMIZATION: Collect all unique release IDs first, then batch fetch
    const releaseIds = new Set<string>();
    for (const order of userOrders) {
      if (order.items && Array.isArray(order.items)) {
        for (const item of order.items) {
          if (item.type === 'digital' || item.type === 'release' || item.type === 'track') {
            const releaseId = item.releaseId || item.productId || item.id;
            if (releaseId) releaseIds.add(releaseId);
          }
        }
      }
    }

    // Batch fetch all releases at once (avoids N+1 queries)
    const releaseCache = releaseIds.size > 0
      ? await getDocumentsBatch('releases', Array.from(releaseIds))
      : new Map<string, Record<string, unknown>>();

    log.info('[get-orders] Batch fetched', releaseCache.size, 'releases for', userOrders.length, 'orders');

    const orders = userOrders.map((orderData: Record<string, unknown>) => {
      if (orderData.items && Array.isArray(orderData.items)) {
        orderData.items = (orderData.items as Record<string, unknown>[]).map((item: Record<string, unknown>) => {
          if (item.type !== 'digital' && item.type !== 'release' && item.type !== 'track') {
            return item;
          }

          // Always look up release for fresh artwork URL (stored URL may be stale)
          const releaseId = item.releaseId || item.productId || item.id;
          if (!releaseId) return item;

          try {
            const releaseData = releaseCache.get(releaseId);

            if (releaseData) {

              if (item.type === 'track') {
                let track = null;

                if (item.trackId) {
                  track = ((releaseData?.tracks || []) as Record<string, unknown>[]).find((t: Record<string, unknown>) =>
                    t.id === item.trackId ||
                    t.trackId === item.trackId ||
                    String(t.trackNumber) === String(item.trackId)
                  );
                }

                if (!track && item.name) {
                  const itemNameParts = item.name.split(' - ');
                  const trackNameFromItem = itemNameParts.length > 1 ? itemNameParts.slice(1).join(' - ') : item.name;
                  track = ((releaseData?.tracks || []) as Record<string, unknown>[]).find((t: Record<string, unknown>) =>
                    ((t.trackName || t.name || '') as string).toLowerCase() === trackNameFromItem.toLowerCase()
                  );
                }

                if (!track && item.title) {
                  track = ((releaseData?.tracks || []) as Record<string, unknown>[]).find((t: Record<string, unknown>) =>
                    ((t.trackName || t.name || '') as string).toLowerCase() === (item.title as string).toLowerCase()
                  );
                }

                const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
                const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';

                // Prioritize release artwork over stored (may be stale/moved)
                const artworkUrl = releaseData?.coverArtUrl || releaseData?.artworkUrl || releaseData?.artwork?.cover || item.image || null;

                if (track) {
                  return {
                    ...item,
                    image: artworkUrl,
                    artwork: artworkUrl,
                    downloads: {
                      artistName,
                      releaseName,
                      artworkUrl,
                      tracks: [{
                        name: track.trackName || track.name || item.title,
                        mp3Url: track.mp3Url || null,
                        wavUrl: track.wavUrl || null
                      }]
                    }
                  };
                } else {
                  return {
                    ...item,
                    image: artworkUrl,
                    artwork: artworkUrl,
                    downloads: {
                      artistName,
                      releaseName,
                      artworkUrl,
                      tracks: ((releaseData?.tracks || []) as Record<string, unknown>[]).map((t: Record<string, unknown>) => ({
                        name: t.trackName || t.name,
                        mp3Url: t.mp3Url || null,
                        wavUrl: t.wavUrl || null
                      }))
                    }
                  };
                }
              }

              const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
              const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';
              // Prioritize release artwork over stored (may be stale/moved)
              const artworkUrl = releaseData?.coverArtUrl || releaseData?.artworkUrl || releaseData?.artwork?.cover || item.image || null;

              return {
                ...item,
                image: artworkUrl,
                artwork: artworkUrl,
                downloads: {
                  artistName,
                  releaseName,
                  artworkUrl,
                  tracks: (releaseData?.tracks || []).map((track: Record<string, unknown>) => ({
                    name: track.trackName || track.name,
                    mp3Url: track.mp3Url || null,
                    wavUrl: track.wavUrl || null
                  }))
                }
              };
            }
          } catch (e: unknown) {
            log.error('[get-orders] Error fetching release:', releaseId, e);
          }

          return item;
        });
      }

      return orderData;
    });

    orders.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    log.info('[get-orders] Found', orders.length, 'orders');

    return successResponse({ orders,
      count: orders.length }, 200, { headers: { 'Cache-Control': 'private, max-age=60' } });

  } catch (error: unknown) {
    log.error('[get-orders] Error:', error);
    return ApiErrors.serverError('Failed to fetch orders');
  }
};
