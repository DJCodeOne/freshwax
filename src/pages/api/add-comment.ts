// src/pages/api/add-comment.ts
// Add comments to releases with optional GIF support
// Dual-write: Firebase + D1
import type { APIRoute } from 'astro';
import { getDocument, arrayUnion, clearCache } from '../../lib/firebase-rest';
import { containsProfanity } from '../../lib/validation';
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

  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({ success: false, error: 'You must be logged in to comment' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const { releaseId, comment, userName: bodyUserName, gifUrl, avatarUrl } = await request.json();

    // SECURITY: Get verified display name from user document instead of trusting body
    let userName = bodyUserName?.trim() || 'User';
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc?.displayName) {
        userName = userDoc.displayName;
      } else if (userDoc?.name) {
        userName = userDoc.name;
      }
    } catch {
      // Fall back to body userName if user doc lookup fails
    }

    log.info('[add-comment] Received:', releaseId, userName, userId, 'hasGif:', !!gifUrl, 'hasAvatar:', !!avatarUrl);

    // Allow GIF-only comments (no text required if GIF present)
    if (!releaseId || (!comment?.trim() && !gifUrl) || !userName?.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate gifUrl if provided (must be from Giphy domain)
    if (gifUrl) {
      let validGif = false;
      try { const u = new URL(gifUrl); validGif = u.hostname === 'giphy.com' || u.hostname.endsWith('.giphy.com'); } catch {}
      if (!validGif) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid GIF URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Content validation: profanity check on comment text
    if (comment?.trim()) {
      const profanityCheck = containsProfanity(comment);
      if (profanityCheck.found) {
        return new Response(JSON.stringify({ success: false, error: 'Please keep comments clean and respectful' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Content validation: profanity check on username
    if (userName?.trim()) {
      const userNameCheck = containsProfanity(userName);
      if (userNameCheck.found) {
        return new Response(JSON.stringify({ success: false, error: 'Username contains inappropriate content' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
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

    // Atomic arrayUnion prevents lost comments under concurrent writes
    await arrayUnion('releases', releaseId, 'comments', [newComment], {
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
    return new Response(JSON.stringify({ success: false, error: 'Failed to add comment' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
