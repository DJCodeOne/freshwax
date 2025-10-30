// src/pages/api/delete-releases.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: import.meta.env.CLOUDINARY_CLOUD_NAME || 'dscqbze0d',
  api_key: import.meta.env.CLOUDINARY_API_KEY || '555922422486159',
  api_secret: import.meta.env.CLOUDINARY_API_SECRET || '1OV_96Pd_x7MSdt7Bph5aNELYho',
});

export const POST: APIRoute = async ({ request }) => {
  console.log('\n========================================');
  console.log('[API] DELETE RELEASES REQUEST');
  console.log('========================================\n');
  
  try {
    const body = await request.json();
    const { releaseIds } = body;

    console.log('[API] Request body:', body);
    console.log('[API] Release IDs to delete:', releaseIds);

    if (!releaseIds || !Array.isArray(releaseIds) || releaseIds.length === 0) {
      console.error('[API] Invalid request: no release IDs provided');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'No release IDs provided' 
        }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Fetch current releases.json from Cloudinary
    console.log('[API] Fetching current releases.json...');
    const info = await cloudinary.api.resource('releases/releases.json', {
      resource_type: 'raw'
    });
    
    const version = info.version;
    const releasesUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/releases/releases.json`;
    
    console.log('[API] Fetching from:', releasesUrl);
    const response = await fetch(releasesUrl, { cache: 'no-store' });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch releases.json: ${response.status}`);
    }

    const currentReleases = await response.json();
    console.log('[API] Current releases count:', currentReleases.length);

    // Filter out the releases to delete
    const beforeCount = currentReleases.length;
    const updatedReleases = currentReleases.filter((release: any) => {
      const shouldKeep = !releaseIds.includes(release.id);
      if (!shouldKeep) {
        console.log('[API] Removing release:', release.id, '-', release.title);
      }
      return shouldKeep;
    });
    
    const deletedCount = beforeCount - updatedReleases.length;
    console.log('[API] Releases after deletion:', updatedReleases.length);
    console.log('[API] Deleted count:', deletedCount);

    if (deletedCount === 0) {
      console.warn('[API] No releases were deleted - IDs may not match');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'No matching releases found to delete' 
        }),
        { 
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Upload updated releases.json back to Cloudinary
    console.log('[API] Uploading updated releases.json...');
    const updatedJson = JSON.stringify(updatedReleases, null, 2);
    
    const uploadResult = await cloudinary.uploader.upload(
      `data:application/json;base64,${Buffer.from(updatedJson).toString('base64')}`,
      {
        resource_type: 'raw',
        public_id: 'releases/releases',
        overwrite: true,
        invalidate: true
      }
    );

    console.log('[API] Upload result:', uploadResult.secure_url);
    console.log('[API] ✓ Successfully deleted', deletedCount, 'release(s)');
    console.log('========================================\n');

    return new Response(
      JSON.stringify({ 
        success: true,
        deletedCount,
        remainingCount: updatedReleases.length,
        message: `Successfully deleted ${deletedCount} release(s)`
      }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('\n========================================');
    console.error('[API] DELETE ERROR');
    console.error('========================================');
    console.error('[API] Error:', error);
    console.error('========================================\n');
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};