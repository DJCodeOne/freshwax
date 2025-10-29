// src/pages/api/delete-mix.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId } = await request.json();
    
    if (!mixId) {
      return new Response(JSON.stringify({ error: 'Mix ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    cloudinary.config({
      cloud_name: 'dscqbze0d',
      api_key: '555922422486159',
      api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
    });

    console.log('=== Starting Mix Deletion ===');
    console.log('Mix ID:', mixId);

    // Step 1: Get current mixes.json
    const info = await cloudinary.api.resource('dj-mixes/mixes.json', {
      resource_type: 'raw'
    });
    
    const version = info.version;
    const mixesUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/dj-mixes/mixes.json`;
    
    const response = await fetch(mixesUrl);
    const mixes = await response.json();

    // Step 2: Find the mix to delete
    const mixIndex = mixes.findIndex((m: any) => m.id === mixId);
    
    if (mixIndex === -1) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixToDelete = mixes[mixIndex];
    console.log('Found mix:', mixToDelete);

    // Step 3: Delete audio file from Cloudinary
    try {
      console.log('Deleting audio:', mixToDelete.audio_public_id);
      await cloudinary.uploader.destroy(mixToDelete.audio_public_id, {
        resource_type: 'video',
        invalidate: true
      });
      console.log('Audio deleted successfully');
    } catch (error) {
      console.error('Failed to delete audio:', error);
      // Continue even if audio deletion fails
    }

    // Step 4: Delete artwork from Cloudinary (if not placeholder)
    if (mixToDelete.artwork_public_id && mixToDelete.artwork_public_id !== 'placeholder_logo') {
      try {
        console.log('Deleting artwork:', mixToDelete.artwork_public_id);
        await cloudinary.uploader.destroy(mixToDelete.artwork_public_id, {
          resource_type: 'image',
          invalidate: true
        });
        console.log('Artwork deleted successfully');
      } catch (error) {
        console.error('Failed to delete artwork:', error);
        // Continue even if artwork deletion fails
      }
    }

    // Step 5: Delete metadata file
    try {
      const metadataPublicId = `${mixToDelete.folder_path}/metadata`;
      console.log('Deleting metadata:', metadataPublicId);
      await cloudinary.uploader.destroy(metadataPublicId, {
        resource_type: 'raw',
        invalidate: true
      });
      console.log('Metadata deleted successfully');
    } catch (error) {
      console.error('Failed to delete metadata:', error);
      // Continue even if metadata deletion fails
    }

    // Step 6: Delete folder (best effort - may fail if not empty)
    try {
      console.log('Deleting folder:', mixToDelete.folder_path);
      await cloudinary.api.delete_folder(mixToDelete.folder_path);
      console.log('Folder deleted successfully');
    } catch (error) {
      console.error('Failed to delete folder:', error);
      // This is expected to fail if files remain, continue anyway
    }

    // Step 7: Remove mix from array
    mixes.splice(mixIndex, 1);

    // Step 8: Upload updated mixes.json
    console.log('Updating mixes.json...');
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

    console.log('=== Mix Deletion Complete ===');

    return new Response(JSON.stringify({
      success: true,
      message: 'Mix deleted successfully',
      deletedMixId: mixId,
      remainingMixes: mixes.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('=== Mix Deletion Error ===');
    console.error(error);
    
    return new Response(JSON.stringify({
      error: 'Failed to delete mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};