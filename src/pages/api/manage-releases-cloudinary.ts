// src/pages/api/manage-releases-cloudinary.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const prerender = false;

// Configure Cloudinary (Images/Metadata account)
cloudinary.config({
  cloud_name: import.meta.env.PUBLIC_CLOUDINARY_CLOUD_IMAGE || 'dm9gldbda',
  api_key: import.meta.env.CLOUDINARY_API_KEY_IMAGE,
  api_secret: import.meta.env.CLOUDINARY_API_SECRET_IMAGE,
});

const MASTER_JSON_PATH = 'releases/releases.json';

async function getMasterJSON() {
  try {
    // Get the resource info to get the latest version
    const info = await cloudinary.api.resource(MASTER_JSON_PATH, {
      resource_type: 'raw'
    });
    
    const version = info.version;
    const url = `https://res.cloudinary.com/${cloudinary.config().cloud_name}/raw/upload/v${version}/${MASTER_JSON_PATH}`;
    
    // Fetch with cache busting
    const response = await fetch(url, { cache: 'no-store' });
    
    if (response.ok) {
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    }
    
    return [];
  } catch (error) {
    console.log('Master JSON not found, creating new one');
    return [];
  }
}

async function saveMasterJSON(releases: any[]) {
  // Convert array to JSON string
  const jsonString = JSON.stringify(releases, null, 2);
  
  // Create a buffer from the JSON string
  const buffer = Buffer.from(jsonString, 'utf-8');
  
  // Upload to Cloudinary as raw file
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
          console.error('Cloudinary upload error:', error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
    
    uploadStream.end(buffer);
  });
}

// GET - Fetch all releases
export const GET: APIRoute = async () => {
  try {
    const releases = await getMasterJSON();
    
    return new Response(
      JSON.stringify({ 
        releases, 
        count: releases.length,
        source: 'cloudinary'
      }),
      {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        },
      }
    );
  } catch (error) {
    console.error('Error fetching releases:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Failed to fetch releases',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

// POST - Add or update release
export const POST: APIRoute = async ({ request }) => {
  try {
    const release = await request.json();
    
    if (!release || !release.id) {
      return new Response(
        JSON.stringify({ error: 'Invalid release data - missing ID' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get current master JSON
    const releases = await getMasterJSON();
    
    // Check if release already exists
    const existingIndex = releases.findIndex((r: any) => r.id === release.id);
    
    let action = 'created';
    if (existingIndex >= 0) {
      // Update existing release
      releases[existingIndex] = {
        ...releases[existingIndex],
        ...release,
        updatedAt: new Date().toISOString()
      };
      action = 'updated';
    } else {
      // Add new release
      releases.push({
        ...release,
        createdAt: release.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    
    // Sort by creation date (newest first)
    releases.sort((a: any, b: any) => {
      const dateA = new Date(a.createdAt || 0).getTime();
      const dateB = new Date(b.createdAt || 0).getTime();
      return dateB - dateA;
    });
    
    // Save updated master JSON back to Cloudinary
    await saveMasterJSON(releases);
    
    const cloudinaryUrl = `https://res.cloudinary.com/${cloudinary.config().cloud_name}/raw/upload/${MASTER_JSON_PATH}`;

    return new Response(
      JSON.stringify({
        success: true,
        message: `Release ${action} successfully in Cloudinary`,
        action,
        id: release.id,
        masterUrl: cloudinaryUrl,
        count: releases.length
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error saving release:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

// DELETE - Remove release
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const { id } = await request.json();
    
    if (!id) {
      return new Response(
        JSON.stringify({ error: 'Release ID is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get current master JSON
    const releases = await getMasterJSON();
    
    // Find the release to get its details
    const releaseToDelete = releases.find((r: any) => r.id === id);
    
    // Filter out the release to delete
    const filteredReleases = releases.filter((r: any) => r.id !== id);
    
    if (filteredReleases.length === releases.length) {
      return new Response(
        JSON.stringify({ error: 'Release not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Save updated master JSON
    await saveMasterJSON(filteredReleases);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Release deleted successfully from Cloudinary',
        id,
        remainingCount: filteredReleases.length,
        deletedRelease: releaseToDelete
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error deleting release:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

// PUT - Update specific fields (for price changes, etc.)
export const PUT: APIRoute = async ({ request }) => {
  try {
    const { id, updates } = await request.json();
    
    if (!id || !updates) {
      return new Response(
        JSON.stringify({ error: 'Release ID and updates are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get current master JSON
    const releases = await getMasterJSON();
    
    // Find and update the release
    const releaseIndex = releases.findIndex((r: any) => r.id === id);
    
    if (releaseIndex === -1) {
      return new Response(
        JSON.stringify({ error: 'Release not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Apply updates
    releases[releaseIndex] = {
      ...releases[releaseIndex],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    // Save updated master JSON
    await saveMasterJSON(releases);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Release updated successfully in Cloudinary',
        release: releases[releaseIndex]
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error updating release:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};