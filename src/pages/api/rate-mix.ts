// src/pages/api/rate-mix.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId, rating } = await request.json();

    if (!mixId || !rating || rating < 1 || rating > 5) {
      return new Response(JSON.stringify({ error: 'Invalid rating' }), {
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

    // Get the mix metadata
    const metadataUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/dj-mixes/approved/${mixId}/metadata.json`;
    const metadataResponse = await fetch(metadataUrl);
    
    if (!metadataResponse.ok) {
      throw new Error('Mix not found');
    }

    const mixMetadata = await metadataResponse.json();

    // Calculate new average rating
    const currentRating = mixMetadata.rating || 0;
    const ratingsCount = mixMetadata.ratings_count || 0;
    const totalRating = currentRating * ratingsCount;
    const newRatingsCount = ratingsCount + 1;
    const newAverageRating = (totalRating + rating) / newRatingsCount;

    // Update metadata
    const updatedMetadata = {
      ...mixMetadata,
      rating: Math.round(newAverageRating * 10) / 10, // Round to 1 decimal place
      ratings_count: newRatingsCount,
    };

    // Save updated metadata
    const metadataJson = JSON.stringify(updatedMetadata, null, 2);
    const metadataBuffer = Buffer.from(metadataJson);
    const metadataDataUri = `data:application/json;base64,${metadataBuffer.toString('base64')}`;

    await cloudinary.uploader.upload(metadataDataUri, {
      resource_type: 'raw',
      folder: `dj-mixes/approved/${mixId}`,
      public_id: 'metadata',
      overwrite: true,
    });

    // Update the main mixes.json file
    const mixesListUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/dj-mixes/mixes.json`;
    const mixesResponse = await fetch(mixesListUrl);
    
    if (mixesResponse.ok) {
      let mixes = await mixesResponse.json();
      
      // Find and update the mix in the list
      const mixIndex = mixes.findIndex((m: any) => m.id === mixId);
      if (mixIndex !== -1) {
        mixes[mixIndex].rating = updatedMetadata.rating;
        mixes[mixIndex].ratings_count = updatedMetadata.ratings_count;

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
      }
    }

    return new Response(JSON.stringify({
      success: true,
      newRating: updatedMetadata.rating,
      ratingsCount: updatedMetadata.ratings_count,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Rating error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to save rating',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};