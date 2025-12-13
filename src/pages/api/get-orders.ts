// src/pages/api/get-orders.ts
// Fetch orders for a customer - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const userId = url.searchParams.get('userId');

  // Cache release lookups within this request to avoid duplicate reads
  const releaseCache = new Map<string, any>();

  async function getCachedRelease(releaseId: string) {
    if (releaseCache.has(releaseId)) {
      return releaseCache.get(releaseId);
    }
    const data = await getDocument('releases', releaseId);
    releaseCache.set(releaseId, data);
    return data;
  }

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'userId is required'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

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

    const orders = await Promise.all(userOrders.map(async (orderData: any) => {
      if (orderData.items && Array.isArray(orderData.items)) {
        orderData.items = await Promise.all(orderData.items.map(async (item: any) => {
          if (item.type !== 'digital' && item.type !== 'release' && item.type !== 'track') {
            return item;
          }

          if (item.downloads?.tracks?.length > 0 && item.downloads.tracks[0]?.mp3Url) {
            return item;
          }

          const releaseId = item.releaseId || item.productId || item.id;
          if (!releaseId) return item;

          try {
            const releaseData = await getCachedRelease(releaseId);

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

                if (track) {
                  return {
                    ...item,
                    downloads: {
                      artistName,
                      releaseName,
                      artworkUrl: releaseData?.artworkUrl || releaseData?.coverArtUrl || null,
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
                    downloads: {
                      artistName,
                      releaseName,
                      artworkUrl: releaseData?.artworkUrl || releaseData?.coverArtUrl || null,
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

              return {
                ...item,
                downloads: {
                  artistName,
                  releaseName,
                  artworkUrl: releaseData?.artworkUrl || releaseData?.coverArtUrl || null,
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
        }));
      }

      return orderData;
    }));

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
