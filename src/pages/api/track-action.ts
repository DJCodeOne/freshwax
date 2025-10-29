// src/pages/api/track-action.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId, action } = await request.json();
    
    if (!mixId || !action || !['play', 'download', 'like'].includes(action)) {
      return new Response(JSON.stringify({ error: 'Invalid parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    cloudinary.config({
      cloud_name: 'dscqbze0d',
      api_key: '555922422486159',
      api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
    });

    // Get current mixes.json
    const info = await cloudinary.api.resource('dj-mixes/mixes.json', {
      resource_type: 'raw'
    });
    
    const version = info.version;
    const mixesUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/dj-mixes/mixes.json`;
    
    const response = await fetch(mixesUrl);
    const mixes = await response.json();

    // Find and update the mix
    const mixIndex = mixes.findIndex((m: any) => m.id === mixId);
    
    if (mixIndex === -1) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Initialize counters if they don't exist
    if (!mixes[mixIndex].plays) mixes[mixIndex].plays = 0;
    if (!mixes[mixIndex].downloads) mixes[mixIndex].downloads = 0;
    if (!mixes[mixIndex].likes) mixes[mixIndex].likes = 0;

    // Increment the appropriate counter
    if (action === 'play') {
      mixes[mixIndex].plays++;
    } else if (action === 'download') {
      mixes[mixIndex].downloads++;
    } else if (action === 'like') {
      mixes[mixIndex].likes++;
    }

    mixes[mixIndex].last_action_date = new Date().toISOString();

    // Upload updated mixes.json
    const mixesJson = JSON.stringify(mixes, null, 2);
    const mixesBytes = Buffer.from(mixesJson);

    await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          public_id: 'dj-mixes/mixes.json',
          use_filename: true,
          unique_filename: false,
          overwrite: true,
          invalidate: true,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(mixesBytes);
    });

    return new Response(JSON.stringify({
      success: true,
      plays: mixes[mixIndex].plays,
      downloads: mixes[mixIndex].downloads,
      likes: mixes[mixIndex].likes
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Track action error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track action',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};