// src/pages/api/track-mix-like.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ error: 'Invalid mixId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Configure Cloudinary
    cloudinary.config({
      cloud_name: 'dscqbze0d',
      api_key: '555922422486159',
      api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
    });

    // Get the main mixes.json file
    const mixesListUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/dj-mixes/mixes.json`;
    const mixesResponse = await fetch(mixesListUrl);
    
    if (!mixesResponse.ok) {
      throw new Error('Mixes list not found');
    }

    let mixes = await mixesResponse.json();
    
    // Find and update the mix in the list
    const mixIndex = mixes.findIndex((m: any) => m.id === mixId);
    if (mixIndex === -1) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Increment likes
    mixes[mixIndex].likes = (mixes[mixIndex].likes || 0) + 1;
    const newLikes = mixes[mixIndex].likes;

    // Upload updated list
    const mixesListJson = JSON.stringify(mixes, null, 2);
    const mixesListBuffer = Buffer.from(mixesListJson);
    const mixesListDataUri = `data:application/json;base64,${mixesListBuffer.toString('base64')}`;

    await cloudinary.uploader.upload(mixesListDataUri, {
      resource_type: 'raw',
      folder: 'dj-mixes',
      public_id: 'mixes',
      overwrite: true,
    });

    // Also update individual mix metadata if it exists
    try {
      const metadataUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/dj-mixes/approved/${mixId}/metadata.json`;
      const metadataResponse = await fetch(metadataUrl);
      
      if (metadataResponse.ok) {
        const mixMetadata = await metadataResponse.json();
        mixMetadata.likes = newLikes;

        const metadataJson = JSON.stringify(mixMetadata, null, 2);
        const metadataBuffer = Buffer.from(metadataJson);
        const metadataDataUri = `data:application/json;base64,${metadataBuffer.toString('base64')}`;

        await cloudinary.uploader.upload(metadataDataUri, {
          resource_type: 'raw',
          folder: `dj-mixes/approved/${mixId}`,
          public_id: 'metadata',
          overwrite: true,
        });
      }
    } catch (metadataError) {
      // Metadata update is optional, don't fail if it doesn't exist
      console.log('Metadata update skipped:', metadataError);
    }

    return new Response(JSON.stringify({
      success: true,
      likes: newLikes,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Like tracking error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track like',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};