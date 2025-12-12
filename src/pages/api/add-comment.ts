// src/pages/api/add-comment.ts
// Add comments to releases with optional GIF support
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { clearCache } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { releaseId, comment, userName, userId, gifUrl, avatarUrl } = await request.json();

    log.info('[add-comment] Received:', releaseId, userName, userId, 'hasGif:', !!gifUrl, 'hasAvatar:', !!avatarUrl);

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'You must be logged in to comment' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Allow GIF-only comments (no text required if GIF present)
    if (!releaseId || (!comment?.trim() && !gifUrl) || !userName?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate gifUrl if provided (must be from Giphy)
    if (gifUrl && !gifUrl.includes('giphy.com')) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid GIF URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const releaseRef = db.collection('releases').doc(releaseId);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      return new Response(JSON.stringify({ success: false, error: 'Release not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const newComment = {
      id: 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      userId,
      userName: userName.trim(),
      avatarUrl: avatarUrl || null,
      comment: comment?.trim() || '',
      gifUrl: gifUrl || null,
      timestamp: new Date().toISOString(),
      approved: true
    };

    await releaseRef.update({
      comments: FieldValue.arrayUnion(newComment),
      updatedAt: new Date().toISOString()
    });

    // Invalidate cache for this release so fresh data is served
    clearCache(`releases:${releaseId}`);
    clearCache(`doc:releases:${releaseId}`);

    log.info('[add-comment] Added comment to:', releaseId);

    return new Response(JSON.stringify({ success: true, comment: newComment }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      } 
    });

  } catch (error) {
    log.error('[add-comment] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to add comment', details: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
