// src/pages/api/publish-releases.js
import { v2 as cloudinary } from 'cloudinary';

export const prerender = false;

cloudinary.config({
  cloud_name: import.meta.env.PUBLIC_CLOUDINARY_CLOUD_IMAGE || 'dscqbze0d',
  api_key: import.meta.env.CLOUDINARY_API_KEY_IMAGE || '555922422486159',
  api_secret: import.meta.env.CLOUDINARY_API_SECRET_IMAGE || '1OV_96Pd_x7MSdt7Bph5aNELYho',
});

const MASTER_JSON_PATH = 'releases/releases.json';

async function getMasterJSON() {
  try {
    console.log('[PUBLISH-RELEASES] Fetching master JSON from Cloudinary...');
    console.log('[PUBLISH-RELEASES] Path:', MASTER_JSON_PATH);
    console.log('[PUBLISH-RELEASES] Cloud name:', cloudinary.config().cloud_name);
    
    // Get the resource info to get the latest version
    const info = await cloudinary.api.resource(MASTER_JSON_PATH, {
      resource_type: 'raw'
    });
    
    const version = info.version;
    console.log('[PUBLISH-RELEASES] Found master JSON version:', version);
    
    const url = `https://res.cloudinary.com/${cloudinary.config().cloud_name}/raw/upload/v${version}/${MASTER_JSON_PATH}`;
    console.log('[PUBLISH-RELEASES] Fetching from URL:', url);
    
    // Fetch with cache busting
    const response = await fetch(url, { 
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache'
      }
    });
    
    console.log('[PUBLISH-RELEASES] Fetch response status:', response.status);
    
    if (response.ok) {
      const data = await response.json();
      const releases = Array.isArray(data) ? data : [];
      console.log('[PUBLISH-RELEASES] Loaded releases count:', releases.length);
      console.log('[PUBLISH-RELEASES] Release IDs:', releases.map(r => r.id).join(', '));
      
      // Log published status
      const publishedCount = releases.filter(r => r.published).length;
      const unpublishedCount = releases.filter(r => !r.published).length;
      console.log('[PUBLISH-RELEASES] Published releases:', publishedCount);
      console.log('[PUBLISH-RELEASES] Unpublished releases:', unpublishedCount);
      
      return releases;
    }
    
    console.log('[PUBLISH-RELEASES] Response not OK, returning empty array');
    return [];
  } catch (error) {
    console.error('[PUBLISH-RELEASES] Error fetching master JSON:', error);
    console.error('[PUBLISH-RELEASES] Error details:', error.message);
    console.error('[PUBLISH-RELEASES] Error stack:', error.stack);
    return [];
  }
}

async function saveMasterJSON(releases) {
  try {
    console.log('[PUBLISH-RELEASES] Saving master JSON...');
    console.log('[PUBLISH-RELEASES] Total releases to save:', releases.length);
    
    // Convert array to JSON string
    const jsonString = JSON.stringify(releases, null, 2);
    console.log('[PUBLISH-RELEASES] JSON string length:', jsonString.length);
    
    // Create a buffer from the JSON string
    const buffer = Buffer.from(jsonString, 'utf-8');
    
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          public_id: MASTER_JSON_PATH,
          overwrite: true,
          invalidate: true, // Invalidate CDN cache
        },
        (error, result) => {
          if (error) {
            console.error('[PUBLISH-RELEASES] Cloudinary upload error:', error);
            reject(error);
          } else {
            console.log('[PUBLISH-RELEASES] Successfully uploaded master JSON');
            console.log('[PUBLISH-RELEASES] New version:', result?.version);
            console.log('[PUBLISH-RELEASES] URL:', result?.secure_url);
            resolve(result);
          }
        }
      );
      
      uploadStream.end(buffer);
    });
  } catch (error) {
    console.error('[PUBLISH-RELEASES] Error in saveMasterJSON:', error);
    throw error;
  }
}

export async function POST({ request }) {
  console.log('\n========================================');
  console.log('[PUBLISH-RELEASES] POST REQUEST RECEIVED');
  console.log('========================================\n');
  
  try {
    // Parse request body
    const body = await request.json();
    console.log('[PUBLISH-RELEASES] Request body:', JSON.stringify(body, null, 2));
    
    const { releaseIds } = body;
    
    // Validate input
    if (!releaseIds) {
      console.error('[PUBLISH-RELEASES] ERROR: No releaseIds provided');
      return new Response(JSON.stringify({ 
        error: 'No release IDs provided',
        received: body
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!Array.isArray(releaseIds)) {
      console.error('[PUBLISH-RELEASES] ERROR: releaseIds is not an array:', typeof releaseIds);
      return new Response(JSON.stringify({ 
        error: 'releaseIds must be an array',
        received: releaseIds,
        type: typeof releaseIds
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (releaseIds.length === 0) {
      console.error('[PUBLISH-RELEASES] ERROR: releaseIds array is empty');
      return new Response(JSON.stringify({ 
        error: 'releaseIds array is empty' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[PUBLISH-RELEASES] Publishing ${releaseIds.length} releases:`, releaseIds);

    // Get current master JSON
    const releases = await getMasterJSON();
    
    if (releases.length === 0) {
      console.error('[PUBLISH-RELEASES] ERROR: No releases found in master JSON');
      return new Response(JSON.stringify({ 
        error: 'No releases found in master JSON. Upload releases first.' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    let updatedCount = 0;
    const notFound = [];
    const alreadyPublished = [];
    const successfullyPublished = [];
    
    // Mark selected releases as published
    releaseIds.forEach(releaseId => {
      console.log(`[PUBLISH-RELEASES] Processing release ID: "${releaseId}"`);
      
      const release = releases.find(r => {
        const match = r.id === releaseId;
        console.log(`[PUBLISH-RELEASES]   Comparing "${r.id}" === "${releaseId}": ${match}`);
        return match;
      });
      
      if (release) {
        console.log(`[PUBLISH-RELEASES]   ✓ Found release: "${release.title}" by ${release.artist}`);
        
        if (release.published) {
          console.log(`[PUBLISH-RELEASES]   ⚠ Already published (skipping)`);
          alreadyPublished.push(releaseId);
        } else {
          release.published = true;
          release.publishedAt = new Date().toISOString();
          release.updatedAt = new Date().toISOString();
          updatedCount++;
          successfullyPublished.push(releaseId);
          console.log(`[PUBLISH-RELEASES]   ✓ Marked as published`);
        }
      } else {
        console.log(`[PUBLISH-RELEASES]   ✗ Release not found`);
        notFound.push(releaseId);
      }
    });

    console.log('\n[PUBLISH-RELEASES] Summary:');
    console.log(`  - Successfully published: ${updatedCount}`);
    console.log(`  - Already published: ${alreadyPublished.length}`);
    console.log(`  - Not found: ${notFound.length}`);

    if (updatedCount === 0 && notFound.length > 0) {
      console.error('[PUBLISH-RELEASES] ERROR: No matching releases found');
      console.error('[PUBLISH-RELEASES] Requested IDs:', releaseIds);
      console.error('[PUBLISH-RELEASES] Available IDs:', releases.map(r => r.id));
      
      return new Response(JSON.stringify({ 
        error: 'No matching releases found to publish',
        requestedIds: releaseIds,
        availableIds: releases.map(r => r.id),
        notFound: notFound,
        suggestion: 'Check that the release IDs match exactly (case-sensitive)'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (updatedCount === 0 && alreadyPublished.length > 0) {
      console.log('[PUBLISH-RELEASES] All selected releases were already published');
      return new Response(JSON.stringify({ 
        success: true,
        message: 'All selected releases were already published',
        alreadyPublished: alreadyPublished.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Save updated master JSON
    console.log('[PUBLISH-RELEASES] Saving updated master JSON...');
    await saveMasterJSON(releases);

    console.log('[PUBLISH-RELEASES] ✓ SUCCESS - Publish complete!');
    console.log('========================================\n');

    return new Response(JSON.stringify({ 
      success: true,
      message: `Published ${updatedCount} release${updatedCount > 1 ? 's' : ''}`,
      publishedCount: updatedCount,
      alreadyPublished: alreadyPublished.length,
      notFound: notFound.length,
      details: {
        successfullyPublished,
        alreadyPublished,
        notFound
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('\n========================================');
    console.error('[PUBLISH-RELEASES] CRITICAL ERROR');
    console.error('========================================');
    console.error('[PUBLISH-RELEASES] Error message:', error.message);
    console.error('[PUBLISH-RELEASES] Error stack:', error.stack);
    console.error('========================================\n');
    
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      message: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}