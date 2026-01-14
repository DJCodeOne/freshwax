// src/pages/api/admin/check-order-files.ts
// Check actual file sizes for all items in an order

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const orderId = url.searchParams.get('orderId');

  if (!orderId) {
    return new Response(JSON.stringify({
      error: 'Missing orderId',
      usage: '/api/admin/check-order-files?orderId=xxx'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const order = await getDocument('orders', orderId);

    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const items = order.items || [];
    const results: any[] = [];

    for (const item of items) {
      const releaseId = item.releaseId || item.productId || item.id;

      if (!releaseId || (item.type !== 'digital' && item.type !== 'release' && item.type !== 'track')) {
        results.push({
          name: item.name || item.title || 'Unknown',
          type: item.type,
          skipped: 'Not a digital item'
        });
        continue;
      }

      // Fetch release data
      const release = await getDocument('releases', releaseId);

      if (!release) {
        results.push({
          name: item.name || item.title || 'Unknown',
          releaseId,
          error: 'Release not found in Firestore'
        });
        continue;
      }

      const tracks = release.tracks || [];
      const trackResults: any[] = [];

      for (const track of tracks) {
        const trackInfo: any = {
          name: track.trackName || track.name || 'Unknown',
          mp3Url: track.mp3Url || null,
          wavUrl: track.wavUrl || null,
          mp3Size: null,
          wavSize: null,
          mp3SizeMB: null,
          wavSizeMB: null
        };

        // Check MP3 size
        if (track.mp3Url) {
          try {
            const mp3Response = await fetch(track.mp3Url, { method: 'HEAD' });
            if (mp3Response.ok) {
              const size = mp3Response.headers.get('content-length');
              if (size) {
                trackInfo.mp3Size = parseInt(size, 10);
                trackInfo.mp3SizeMB = (trackInfo.mp3Size / (1024 * 1024)).toFixed(2);
              }
            } else {
              trackInfo.mp3Error = `HTTP ${mp3Response.status}`;
            }
          } catch (e) {
            trackInfo.mp3Error = e instanceof Error ? e.message : 'Unknown error';
          }
        }

        // Check WAV size
        if (track.wavUrl) {
          try {
            const wavResponse = await fetch(track.wavUrl, { method: 'HEAD' });
            if (wavResponse.ok) {
              const size = wavResponse.headers.get('content-length');
              if (size) {
                trackInfo.wavSize = parseInt(size, 10);
                trackInfo.wavSizeMB = (trackInfo.wavSize / (1024 * 1024)).toFixed(2);
              }
            } else {
              trackInfo.wavError = `HTTP ${wavResponse.status}`;
            }
          } catch (e) {
            trackInfo.wavError = e instanceof Error ? e.message : 'Unknown error';
          }
        }

        trackResults.push(trackInfo);
      }

      // Calculate totals for this release
      const totalMp3 = trackResults.reduce((sum: number, t: any) => sum + (t.mp3Size || 0), 0);
      const totalWav = trackResults.reduce((sum: number, t: any) => sum + (t.wavSize || 0), 0);

      results.push({
        name: item.name || item.title || release.releaseName || 'Unknown',
        releaseId,
        artistName: release.artistName,
        releaseName: release.releaseName || release.title,
        trackCount: tracks.length,
        totals: {
          mp3Bytes: totalMp3,
          mp3MB: (totalMp3 / (1024 * 1024)).toFixed(2),
          wavBytes: totalWav,
          wavMB: (totalWav / (1024 * 1024)).toFixed(2)
        },
        tracks: trackResults
      });
    }

    return new Response(JSON.stringify({
      orderId,
      orderNumber: order.orderNumber,
      customerEmail: order.customer?.email,
      itemCount: items.length,
      items: results
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
