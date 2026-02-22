// src/pages/api/add-comment.ts
// Add comments to releases with optional GIF support
// Dual-write: Firebase + D1
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, arrayUnion, clearCache } from '../../lib/firebase-rest';
import { containsProfanity } from '../../lib/validation';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { d1AddComment } from '../../lib/d1-catalog';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

export const prerender = false;

const AddCommentSchema = z.object({
  releaseId: z.string().min(1, 'Release ID is required').max(200),
  comment: z.string().max(2000).optional(),
  userName: z.string().max(100).optional(),
  gifUrl: z.string().url().max(2048).optional().nullable(),
  avatarUrl: z.string().url().max(2048).optional().nullable(),
});

const logger = createLogger('add-comment');

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: chat/comments - 30 per minute per IP
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`add-comment:${clientId}`, RateLimiters.chat);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;

  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('You must be logged in to comment');
    }

    const rawBody = await request.json();
    const parsed = AddCommentSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { releaseId, comment, userName: bodyUserName, gifUrl, avatarUrl } = parsed.data;

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

    logger.info('[add-comment] Received:', releaseId, userName, userId, 'hasGif:', !!gifUrl, 'hasAvatar:', !!avatarUrl);

    // Allow GIF-only comments (no text required if GIF present)
    if (!releaseId || (!comment?.trim() && !gifUrl) || !userName?.trim()) {
      return ApiErrors.badRequest('Missing required fields');
    }

    // Validate gifUrl if provided (must be from Giphy domain)
    if (gifUrl) {
      let validGif = false;
      try { const u = new URL(gifUrl); validGif = u.hostname === 'giphy.com' || u.hostname.endsWith('.giphy.com'); } catch (_e: unknown) { /* non-critical: invalid URL format */ }
      if (!validGif) {
        return ApiErrors.badRequest('Invalid GIF URL');
      }
    }

    // Content validation: profanity check on comment text
    if (comment?.trim()) {
      const profanityCheck = containsProfanity(comment);
      if (profanityCheck.found) {
        return ApiErrors.badRequest('Please keep comments clean and respectful');
      }
    }

    // Content validation: profanity check on username
    if (userName?.trim()) {
      const userNameCheck = containsProfanity(userName);
      if (userNameCheck.found) {
        return ApiErrors.badRequest('Username contains inappropriate content');
      }
    }

    const release = await getDocument('releases', releaseId);

    if (!release) {
      return ApiErrors.notFound('Release not found');
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
        logger.info('[add-comment] Also written to D1');
      } catch (d1Error: unknown) {
        logger.error('[add-comment] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Invalidate cache for this release so fresh data is served
    clearCache(`releases:${releaseId}`);
    clearCache(`doc:releases:${releaseId}`);

    // Invalidate KV cache for releases list so all edge workers serve fresh data
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => {});
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => {});

    logger.info('[add-comment] Added comment to:', releaseId);

    return successResponse({ comment: newComment }, 200, {
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });

  } catch (error: unknown) {
    logger.error('[add-comment] Error:', error);
    return ApiErrors.serverError('Failed to add comment');
  }
};
