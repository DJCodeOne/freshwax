// src/pages/api/add-comment.ts
// Add comments to releases with optional GIF support
// Dual-write: Firebase + D1
import type { APIRoute } from 'astro';
import { getDocument, arrayUnion, clearCache, initFirebaseEnv } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { d1AddComment } from '../../lib/d1-catalog';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: chat/comments - 30 per minute per IP
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`add-comment:${clientId}`, RateLimiters.chat);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  // Initialize Firebase for Cloudflare runtime
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({ success: false, error: 'You must be logged in to comment' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const { releaseId, comment, userName, gifUrl, avatarUrl } = await request.json();

    log.info('[add-comment] Received:', releaseId, userName, userId, 'hasGif:', !!gifUrl, 'hasAvatar:', !!avatarUrl);

    // Allow GIF-only comments (no text required if GIF present)
    if (!releaseId || (!comment?.trim() && !gifUrl) || !userName?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate gifUrl if provided (must be from Giphy)
    if (gifUrl && !gifUrl.includes('giphy.com')) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid GIF URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const release = await getDocument('releases', releaseId);

    if (!release) {
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

    await arrayUnion('releases', releaseId, 'comments', [newComment]);

    // Also update the updatedAt timestamp
    const { updateDocument } = await import('../../lib/firebase-rest');
    await updateDocument('releases', releaseId, {
      updatedAt: new Date().toISOString()
    });

    // Dual-write to D1 (non-blocking)
    if (db) {
      try {
        await d1AddComment(db, {
          id: newComment.id,
          itemId: releaseId,
          itemType: 'release',
          userId: newComment.userId,
          userName: newComment.userName,
          avatarUrl: newComment.avatarUrl || undefined,
          comment: newComment.comment,
          gifUrl: newComment.gifUrl || undefined
        });
        log.info('[add-comment] Also written to D1');
      } catch (d1Error) {
        log.error('[add-comment] D1 dual-write failed (non-critical):', d1Error);
      }
    }

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
