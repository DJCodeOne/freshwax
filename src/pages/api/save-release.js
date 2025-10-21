// src/pages/api/save-release.js
export const prerender = false;

import fs from 'fs/promises';
import path from 'path';

export async function POST({ request }) {
  try {
    const releaseData = await request.json();
    
    // Validate required fields
    if (!releaseData.id || !releaseData.title || !releaseData.artist) {
      return new Response(JSON.stringify({ 
        error: 'Missing required fields: id, title, or artist' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Path to releases.json in the public/data directory
    const dataDir = path.join(process.cwd(), 'public', 'data');
    const filePath = path.join(dataDir, 'releases.json');
    
    // Ensure the data directory exists
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      // Directory might already exist, ignore error
    }
    
    // Read existing releases or create empty array
    let releases = [];
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(fileContent);
      releases = data.releases || [];
    } catch (err) {
      // File doesn't exist yet, will create it
      console.log('Creating new releases.json file');
    }
    
    // Check if release already exists (update instead of duplicate)
    const existingIndex = releases.findIndex(r => r.id === releaseData.id);
    
    if (existingIndex >= 0) {
      // Update existing release
      releases[existingIndex] = {
        ...releaseData,
        updatedAt: new Date().toISOString()
      };
      console.log(`Updated release: ${releaseData.id}`);
    } else {
      // Add new release to the beginning (newest first)
      releases.unshift({
        ...releaseData,
        createdAt: new Date().toISOString()
      });
      console.log(`Added new release: ${releaseData.id}`);
    }
    
    // Write back to file
    await fs.writeFile(
      filePath, 
      JSON.stringify({ releases }, null, 2),
      'utf-8'
    );
    
    return new Response(JSON.stringify({ 
      success: true, 
      releaseId: releaseData.id,
      action: existingIndex >= 0 ? 'updated' : 'created',
      totalReleases: releases.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error saving release:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Failed to save release to database'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Optional: GET endpoint to retrieve all releases
export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'public', 'data', 'releases.json');
    
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(fileContent);
      
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      // File doesn't exist, return empty array
      return new Response(JSON.stringify({ releases: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
  } catch (error) {
    console.error('Error reading releases:', error);
    return new Response(JSON.stringify({ 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Optional: DELETE endpoint to remove a release
export async function DELETE({ request }) {
  try {
    const { id } = await request.json();
    
    if (!id) {
      return new Response(JSON.stringify({ 
        error: 'Release ID is required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const filePath = path.join(process.cwd(), 'public', 'data', 'releases.json');
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(fileContent);
    
    const releases = data.releases || [];
    const filteredReleases = releases.filter(r => r.id !== id);
    
    if (releases.length === filteredReleases.length) {
      return new Response(JSON.stringify({ 
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    await fs.writeFile(
      filePath, 
      JSON.stringify({ releases: filteredReleases }, null, 2),
      'utf-8'
    );
    
    return new Response(JSON.stringify({ 
      success: true,
      deletedId: id,
      totalReleases: filteredReleases.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error deleting release:', error);
    return new Response(JSON.stringify({ 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}