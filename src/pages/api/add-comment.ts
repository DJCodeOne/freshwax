// src/pages/api/add-comment.ts
// Uses Firebase as source of truth

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { releaseId, comment, userName, userId } = await request.json();

    console.log('[add-comment] Received request:', { releaseId, userName, userId });

    // Validate inputs
    if (!userId) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'You must be logged in to comment' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!releaseId || !comment?.trim() || !userName?.trim()) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Missing required fields' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get release from Firebase
    const releaseRef = db.collection('releases').doc(releaseId);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const releaseData = releaseDoc.data();

    // Initialize comments array if needed
    if (!releaseData.comments) {
      releaseData.comments = [];
    }

    // Create new comment
    const newComment = {
      id: `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      userName: userName.trim(),
      comment: comment.trim(),
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    console.log('[add-comment] Adding comment:', newComment);

    // Add comment to array
    releaseData.comments.push(newComment);
    releaseData.updatedAt = new Date().toISOString();

    // Save to Firebase
    await releaseRef.update({
      comments: releaseData.comments,
      updatedAt: releaseData.updatedAt
    });

    console.log('[add-comment] ✓ Comment saved to Firebase');

    return new Response(JSON.stringify({
      success: true,
      comment: newComment,
      commentsCount: releaseData.comments.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[add-comment] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to save comment',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};