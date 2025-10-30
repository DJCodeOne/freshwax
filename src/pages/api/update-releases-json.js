// src/pages/api/update-releases-json.js
import { v2 as cloudinary } from 'cloudinary';

export const prerender = false;

cloudinary.config({
  cloud_name: import.meta.env.CLOUDINARY_CLOUD_NAME || 'dscqbze0d',
  api_key: import.meta.env.CLOUDINARY_API_KEY || '555922422486159',
  api_secret: import.meta.env.CLOUDINARY_API_SECRET || '1OV_96Pd_x7MSdt7Bph5aNELYho',
});

export async function POST({ request }) {
  try {
    const { release } = await request.json();

    if (!release) {
      return new Response(JSON.stringify({ error: 'No release data provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Updating releases.json with new release:', release.id);

    // Step 1: Fetch current releases.json from Cloudinary
    let currentReleases = [];
    
    try {
      const info = await cloudinary.api.resource('releases/releases.json', {
        resource_type: 'raw'
      });
      
      const version = info.version;
      const releasesUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/releases/releases.json`;
      
      const response = await fetch(releasesUrl, { cache: 'no-store' });
      
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          currentReleases = data;
        }
      }
    } catch (error) {
      // File doesn't exist yet, start with empty array
      console.log('releases.json not found, creating new one');
      currentReleases = [];
    }

    // Step 2: Add or update the release
    const existingIndex = currentReleases.findIndex(r => r.id === release.id);
    
    if (existingIndex >= 0) {
      // Update existing release
      currentReleases[existingIndex] = {
        ...currentReleases[existingIndex],
        ...release,
        updatedAt: new Date().toISOString()
      };
      console.log('Updated existing release:', release.id);
    } else {
      // Add new release
      currentReleases.push({
        ...release,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      console.log('Added new release:', release.id);
    }

    // Step 3: Sort releases by date (newest first)
    currentReleases.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0);
      const dateB = new Date(b.createdAt || 0);
      return dateB - dateA;
    });

    // Step 4: Upload updated JSON to Cloudinary
    const jsonString = JSON.stringify(currentReleases, null, 2);
    
    await cloudinary.uploader.upload(
      `data:application/json;base64,${Buffer.from(jsonString).toString('base64')}`,
      {
        resource_type: 'raw',
        public_id: 'releases/releases',
        format: 'json',
        overwrite: true,
        invalidate: true
      }
    );

    console.log('Successfully updated releases.json in Cloudinary');

    return new Response(JSON.stringify({ 
      success: true,
      message: 'releases.json updated successfully',
      totalReleases: currentReleases.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error updating releases.json:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// GET endpoint to fetch current releases
export async function GET() {
  try {
    const info = await cloudinary.api.resource('releases/releases.json', {
      resource_type: 'raw'
    });
    
    const version = info.version;
    const releasesUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/releases/releases.json`;
    
    const response = await fetch(releasesUrl, { cache: 'no-store' });
    
    if (!response.ok) {
      throw new Error('Failed to fetch releases.json');
    }
    
    const releases = await response.json();

    return new Response(JSON.stringify(releases), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error fetching releases:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      releases: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}