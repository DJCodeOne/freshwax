// src/pages/api/admin/check-file-sizes.ts
// Check actual file sizes from release URLs

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const releaseId = url.searchParams.get('releaseId');

  if (!releaseId) {
    return new Response(JSON.stringify({
      error: 'Missing releaseId',
      usage: '/api/admin/check-file-sizes?releaseId=xxx'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const release = await getDocument('releases', releaseId);

    if (!release) {
      return new Response(JSON.stringify({ error: 'Release not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tracks = release.tracks || [];
    const results: any[] = [];

    for (const track of tracks) {
      const trackResult: any = {
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
              trackResult.mp3Size = parseInt(size, 10);
              trackResult.mp3SizeMB = (trackResult.mp3Size / (1024 * 1024)).toFixed(2);
            }
          } else {
            trackResult.mp3Error = `HTTP ${mp3Response.status}`;
          }
        } catch (e) {
          trackResult.mp3Error = e instanceof Error ? e.message : 'Unknown error';
        }
      }

      // Check WAV size
      if (track.wavUrl) {
        try {
          const wavResponse = await fetch(track.wavUrl, { method: 'HEAD' });
          if (wavResponse.ok) {
            const size = wavResponse.headers.get('content-length');
            if (size) {
              trackResult.wavSize = parseInt(size, 10);
              trackResult.wavSizeMB = (trackResult.wavSize / (1024 * 1024)).toFixed(2);
            }
          } else {
            trackResult.wavError = `HTTP ${wavResponse.status}`;
          }
        } catch (e) {
          trackResult.wavError = e instanceof Error ? e.message : 'Unknown error';
        }
      }

      results.push(trackResult);
    }

    // Calculate totals
    const totalMp3 = results.reduce((sum, t) => sum + (t.mp3Size || 0), 0);
    const totalWav = results.reduce((sum, t) => sum + (t.wavSize || 0), 0);

    return new Response(JSON.stringify({
      releaseId,
      releaseName: release.releaseName || release.title,
      artistName: release.artistName,
      trackCount: tracks.length,
      totals: {
        mp3Bytes: totalMp3,
        mp3MB: (totalMp3 / (1024 * 1024)).toFixed(2),
        wavBytes: totalWav,
        wavMB: (totalWav / (1024 * 1024)).toFixed(2)
      },
      tracks: results
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
