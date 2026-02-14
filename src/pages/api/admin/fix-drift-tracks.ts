// Temporary one-shot endpoint to fix Mispent/Drift track URLs
// DELETE THIS FILE after running once

import type { APIRoute } from 'astro';
import { getDocument, updateDocument } from '../../../lib/firebase-rest';
export const prerender = false;

// TEMPORARY one-shot fix - no auth, hardcoded fix, DELETE immediately after use
export const GET: APIRoute = async ({ request, locals }) => {

  const releaseId = 'code_one_FW-1765803666207';
  const cdnBase = 'https://cdn.freshwax.co.uk/releases/code_one_FW-1765803666207/tracks';

  try {
    // Get current release
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return new Response(JSON.stringify({ error: 'Release not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    const tracks = release.tracks || [];
    if (tracks.length < 2) {
      return new Response(JSON.stringify({ error: 'Less than 2 tracks found', count: tracks.length }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Log current state
    const before = {
      track0: { name: tracks[0].trackName, mp3: tracks[0].mp3Url, wav: tracks[0].wavUrl, preview: tracks[0].previewUrl },
      track1: { name: tracks[1].trackName, mp3: tracks[1].mp3Url, wav: tracks[1].wavUrl, preview: tracks[1].previewUrl }
    };

    // Fix Track 0 (Mispent): add missing preview URL
    tracks[0].previewUrl = `${cdnBase}/01-mispent.mp3`;

    // Fix Track 1 (Drift): correct all URLs from mispent to drift
    tracks[1].mp3Url = `${cdnBase}/02-drift.mp3`;
    tracks[1].wavUrl = `${cdnBase}/02-drift.wav`;
    tracks[1].previewUrl = `${cdnBase}/02-drift.mp3`;

    // Update Firestore
    await updateDocument('releases', releaseId, { tracks });

    const after = {
      track0: { name: tracks[0].trackName, mp3: tracks[0].mp3Url, wav: tracks[0].wavUrl, preview: tracks[0].previewUrl },
      track1: { name: tracks[1].trackName, mp3: tracks[1].mp3Url, wav: tracks[1].wavUrl, preview: tracks[1].previewUrl }
    };

    return new Response(JSON.stringify({
      success: true,
      message: 'Track URLs fixed',
      before,
      after
    }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[fix-drift] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to fix tracks',
      details: error instanceof Error ? error.message : 'Unknown'
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};
