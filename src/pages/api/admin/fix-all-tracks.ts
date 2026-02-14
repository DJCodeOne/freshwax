// Temporary one-shot endpoint to fix all track URL issues
// DELETE THIS FILE after running once

import type { APIRoute } from 'astro';
import { getDocument, updateDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const results: any[] = [];

  try {
    // Fix 1: "Self(sic)" EP - Track 1 "Helvete" preview points to Contempt
    const bsod = await getDocument('releases', 'bsod_FW-1768396912676');
    if (bsod?.tracks?.length >= 2) {
      bsod.tracks[1].previewUrl = 'https://cdn.freshwax.co.uk/releases/bsod_FW-1768396912676/tracks/02-helvete.mp3';
      await updateDocument('releases', 'bsod_FW-1768396912676', { tracks: bsod.tracks });
      results.push({ release: 'Self(sic) EP', fix: 'Track 1 Helvete preview → 02-helvete.mp3', success: true });
    }

    // Fix 2: Radioactive EP - Track 1 "Nuclear Fallout" preview points to Damage Control
    const ds = await getDocument('releases', 'deadly_silence_FW-1768396940695');
    if (ds?.tracks?.length >= 2) {
      ds.tracks[1].previewUrl = 'https://cdn.freshwax.co.uk/releases/deadly_silence_FW-1768396940695/tracks/02-nuclear-fallout.mp3';
      await updateDocument('releases', 'deadly_silence_FW-1768396940695', { tracks: ds.tracks });
      results.push({ release: 'Radioactive EP', fix: 'Track 1 Nuclear Fallout preview → 02-nuclear-fallout.mp3', success: true });
    }

    // Fix 3: Curiosity Vol.1 - All 5 tracks missing preview, set to mp3Url
    const curiosity = await getDocument('releases', 'underground_lair_recordings_FW-1767368892434');
    if (curiosity?.tracks) {
      for (let i = 0; i < curiosity.tracks.length; i++) {
        if (!curiosity.tracks[i].previewUrl && curiosity.tracks[i].mp3Url) {
          curiosity.tracks[i].previewUrl = curiosity.tracks[i].mp3Url;
        }
      }
      await updateDocument('releases', 'underground_lair_recordings_FW-1767368892434', { tracks: curiosity.tracks });
      results.push({ release: 'Curiosity Vol.1', fix: 'Set all 5 preview URLs to mp3Url', success: true });
    }

    // Fix 4: Ultron EP - All 5 tracks missing preview, set to mp3Url
    const ultron = await getDocument('releases', 'skru_ultron-ep_FW-1767981893');
    if (ultron?.tracks) {
      for (let i = 0; i < ultron.tracks.length; i++) {
        if (!ultron.tracks[i].previewUrl && ultron.tracks[i].mp3Url) {
          ultron.tracks[i].previewUrl = ultron.tracks[i].mp3Url;
        }
      }
      await updateDocument('releases', 'skru_ultron-ep_FW-1767981893', { tracks: ultron.tracks });
      results.push({ release: 'Ultron EP', fix: 'Set all 5 preview URLs to mp3Url', success: true });
    }

    return new Response(JSON.stringify({ success: true, fixes: results }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown',
      partialResults: results
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
