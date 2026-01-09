// src/pages/api/get-orders.ts
// Fetch orders for a customer - uses Firebase REST API
// Optimized: Uses batch fetch for releases to avoid N+1 queries
// SECURITY: Requires authentication - user can only view their own orders
import type { APIRoute } from 'astro';
import { queryCollection, getDocumentsBatch, verifyRequestUser, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // SECURITY: Verify the requesting user's identity
  const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);

  if (authError || !verifiedUserId) {
    return new Response(JSON.stringify({
      success: false,
      error: authError || 'Authentication required'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // User can only fetch their own orders
  const userId = verifiedUserId;

  try {
    log.info('[get-orders] Fetching orders for user:', userId);

    // Fetch all orders and filter client-side (REST API has limited query support)
    const allOrders = await queryCollection('orders', {
      limit: 200,
      skipCache: true
    });

    // Filter orders for this user
    const userOrders = allOrders.filter((order: any) =>
      order.customer?.userId === userId ||
      order.userId === userId ||
      order.customerId === userId
    );

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
      : new Map<string, any>();

    log.info('[get-orders] Batch fetched', releaseCache.size, 'releases for', userOrders.length, 'orders');

    const orders = userOrders.map((orderData: any) => {
      if (orderData.items && Array.isArray(orderData.items)) {
        orderData.items = orderData.items.map((item: any) => {
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
                  track = (releaseData?.tracks || []).find((t: any) =>
                    t.id === item.trackId ||
                    t.trackId === item.trackId ||
                    String(t.trackNumber) === String(item.trackId)
                  );
                }

                if (!track && item.name) {
                  const itemNameParts = item.name.split(' - ');
                  const trackNameFromItem = itemNameParts.length > 1 ? itemNameParts.slice(1).join(' - ') : item.name;
                  track = (releaseData?.tracks || []).find((t: any) =>
                    (t.trackName || t.name || '').toLowerCase() === trackNameFromItem.toLowerCase()
                  );
                }

                if (!track && item.title) {
                  track = (releaseData?.tracks || []).find((t: any) =>
                    (t.trackName || t.name || '').toLowerCase() === item.title.toLowerCase()
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
                      tracks: (releaseData?.tracks || []).map((t: any) => ({
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
                  tracks: (releaseData?.tracks || []).map((track: any) => ({
                    name: track.trackName || track.name,
                    mp3Url: track.mp3Url || null,
                    wavUrl: track.wavUrl || null
                  }))
                }
              };
            }
          } catch (e) {
            log.error('[get-orders] Error fetching release:', releaseId, e);
          }

          return item;
        });
      }

      return orderData;
    });

    orders.sort((a: any, b: any) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    log.info('[get-orders] Found', orders.length, 'orders');

    return new Response(JSON.stringify({
      success: true,
      orders,
      count: orders.length
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60'
      }
    });

  } catch (error) {
    log.error('[get-orders] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch orders',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
