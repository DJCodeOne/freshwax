// src/pages/api/save-release.js
// Saves releases ONLY to Firebase (not static files)
export const prerender = false;

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db;

// Initialize Firebase Admin SDK
function initializeFirebase() {
  if (getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId: import.meta.env.FIREBASE_PROJECT_ID,
        clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
        privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
  }
  return getFirestore();
}

try {
  db = initializeFirebase();
} catch (error) {
  console.error('Failed to initialize Firebase:', error);
}

export async function POST({ request }) {
  try {
    if (!db) {
      throw new Error('Firebase not initialized');
    }

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
    
    const releaseId = releaseData.id;
    const now = new Date().toISOString();
    
    // Generate filename if not provided
    const filename = releaseData.filename || 
      `${releaseData.artist}-${releaseData.title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    
    // Check if release already exists
    const releaseRef = db.collection('releases').doc(releaseId);
    const existingDoc = await releaseRef.get();
    const isUpdate = existingDoc.exists;
    
    // Prepare release document for Firestore
    const firestoreRelease = {
      // All release data
      ...releaseData,
      
      // Ensure filename is set
      filename: filename,
      
      // Timestamps
      updatedAt: now,
      
      // Set defaults for new releases
      isPublished: releaseData.isPublished !== undefined ? releaseData.isPublished : true,
      isFeatured: releaseData.isFeatured || false,
      
      // Analytics
      views: releaseData.views || 0,
      sales: releaseData.sales || 0,
      vinylSold: releaseData.vinylSold || 0,
      
      // Display options (from editor)
      displayOptions: releaseData.displayOptions || {
        showLabel: true,
        showGenre: true,
        showDescription: true,
        showExtraNotes: true
      }
    };
    
    // Add creation timestamps for new releases
    if (!isUpdate) {
      firestoreRelease.createdAt = now;
      firestoreRelease.publishedAt = now;
    }
    
    // Save to Firestore
    await releaseRef.set(firestoreRelease, { merge: true });
    
    console.log(`✅ ${isUpdate ? 'Updated' : 'Created'} release in Firebase:`, releaseId);
    
    return new Response(JSON.stringify({ 
      success: true, 
      releaseId: releaseId,
      filename: filename,
      action: isUpdate ? 'updated' : 'created',
      message: `Release ${isUpdate ? 'updated' : 'published'} successfully! ${isUpdate ? 'Changes are live.' : 'It\'s now live in your store.'}`,
      savedTo: 'firebase',
      timestamp: now
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('❌ Error saving release:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Failed to save release to Firebase',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// GET all releases from Firestore
export async function GET({ url }) {
  try {
    if (!db) {
      throw new Error('Firebase not initialized');
    }

    const searchParams = url.searchParams;
    const publishedOnly = searchParams.get('published') !== 'false';
    const featured = searchParams.get('featured') === 'true';
    const limit = parseInt(searchParams.get('limit')) || null;
    
    let query = db.collection('releases');
    
    // Filter by published status
    if (publishedOnly) {
      query = query.where('isPublished', '==', true);
    }
    
    // Filter by featured
    if (featured) {
      query = query.where('isFeatured', '==', true);
    }
    
    // Order by release date (newest first)
    query = query.orderBy('releaseDate', 'desc');
    
    // Limit results
    if (limit) {
      query = query.limit(limit);
    }
    
    const snapshot = await query.get();
    const releases = [];
    
    snapshot.forEach(doc => {
      releases.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    return new Response(JSON.stringify({ 
      releases,
      count: releases.length,
      filters: {
        published: publishedOnly,
        featured: featured,
        limit: limit
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('❌ Error fetching releases:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Failed to fetch releases from Firebase'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// PATCH - Update specific fields (for quick edits from admin panel)
export async function PATCH({ request }) {
  try {
    if (!db) {
      throw new Error('Firebase not initialized');
    }

    const { id, updates } = await request.json();
    
    if (!id) {
      return new Response(JSON.stringify({ 
        error: 'Release ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!updates || Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ 
        error: 'Updates object required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Add updated timestamp
    const updateData = {
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    // Update in Firestore
    await db.collection('releases').doc(id).update(updateData);
    
    console.log(`✅ Updated release fields:`, id, Object.keys(updates));
    
    return new Response(JSON.stringify({ 
      success: true,
      releaseId: id,
      updatedFields: Object.keys(updates),
      message: 'Release updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('❌ Error updating release:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Failed to update release in Firebase'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// DELETE release from Firestore
export async function DELETE({ request }) {
  try {
    if (!db) {
      throw new Error('Firebase not initialized');
    }

    const { id } = await request.json();
    
    if (!id) {
      return new Response(JSON.stringify({ 
        error: 'Release ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if release exists
    const releaseRef = db.collection('releases').doc(id);
    const doc = await releaseRef.get();
    
    if (!doc.exists) {
      return new Response(JSON.stringify({ 
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Delete from Firestore
    await releaseRef.delete();
    
    console.log(`✅ Deleted release:`, id);
    
    return new Response(JSON.stringify({ 
      success: true,
      deletedId: id,
      message: 'Release deleted successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('❌ Error deleting release:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Failed to delete release from Firebase'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}