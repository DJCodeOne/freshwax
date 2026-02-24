// src/pages/api/add-mix-comment.ts
// Stores comments as array within the dj-mix document (matching releases pattern)
// Dual-write: Firebase + D1

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, arrayUnion, clearCache } from '../../lib/firebase-rest';
import { containsProfanity } from '../../lib/validation';
import { d1AddComment } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { kvDelete } from '../../lib/kv-cache';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

export const prerender = false;

const AddMixCommentSchema = z.object({
  mixId: z.string().min(1, 'Mix ID is required').max(200),
  comment: z.string().max(300).optional(),
  userName: z.string().max(30).optional(),
  gifUrl: z.string().url().max(2048).optional().nullable(),
  avatarUrl: z.string().url().max(2048).optional().nullable(),
});

const log = createLogger('add-mix-comment');

function containsLinks(text: string): boolean {
  const urlPatterns = [
    /https?:\/\/[^\s]+/i,
    /www\.[^\s]+/i,
    /[a-zA-Z0-9-]+\.(com|org|net|co\.uk|io|xyz|info|biz|me|tv|app|dev|uk|de|fr|es|it|nl|be|au|ca|us|ru|cn|jp|br|in|mx|ar|ch|at|pl|se|no|dk|fi|ie|pt|gr|cz|hu|ro|bg|hr|sk|si|lt|lv|ee|ua|by|kz|tr|il|sa|ae|za|ng|ke|eg|ma|pk|bd|id|my|sg|th|vn|ph|tw|hk|kr|nz)\b/i,
    /bit\.ly|tinyurl|goo\.gl|t\.co|ow\.ly|buff\.ly|dlvr\.it/i,
    /discord\.(gg|com)|telegram\.(me|org)|whatsapp\.com/i
  ];
  return urlPatterns.some(pattern => pattern.test(text));
}

function containsSpam(text: string): { isSpam: boolean; reason?: string } {
  const lowerText = text.toLowerCase();
  
  if (text.length > 10) {
    const capsCount = (text.match(/[A-Z]/g) || []).length;
    const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && capsCount / letterCount > 0.5) {
      return { isSpam: true, reason: 'Excessive capital letters' };
    }
  }
  
  const spamKeywords = [
    'buy now', 'click here', 'free money', 'make money fast',
    'work from home', 'earn cash', 'bitcoin', 'crypto invest',
    'forex', 'trading signals', 'dm me', 'check my bio',
    'follow me', 'sub4sub', 'f4f', 'check out my',
    'onlyfans', 'premium snap', 'cashapp', 'venmo me',
    'telegram group', 'whatsapp group', 'join my'
  ];
  
  for (const keyword of spamKeywords) {
    if (lowerText.includes(keyword)) {
      return { isSpam: true, reason: 'Promotional content' };
    }
  }
  
  if (/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text)) {
    return { isSpam: true, reason: 'Phone numbers not allowed' };
  }
  
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    return { isSpam: true, reason: 'Email addresses not allowed' };
  }
  
  return { isSpam: false };
}

function validateContent(text: string): { valid: boolean; error?: string } {
  const profanityCheck = containsProfanity(text);
  if (profanityCheck.found) {
    return { valid: false, error: 'Please keep comments clean and respectful' };
  }
  
  if (containsLinks(text)) {
    return { valid: false, error: 'Links are not allowed in comments' };
  }
  
  const spamCheck = containsSpam(text);
  if (spamCheck.isSpam) {
    return { valid: false, error: spamCheck.reason || 'Comment flagged as spam' };
  }
  
  return { valid: true };
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: chat - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`add-mix-comment:${clientId}`, RateLimiters.chat);
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
    const parsed = AddMixCommentSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { mixId, comment, userName: bodyUserName, gifUrl, avatarUrl } = parsed.data;

    // SECURITY: Get verified display name from user document instead of trusting body
    let userName = bodyUserName?.trim() || 'User';
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc?.displayName) {
        userName = userDoc.displayName;
      } else if (userDoc?.name) {
        userName = userDoc.name;
      }
    } catch (e: unknown) {
      // Fall back to body userName if user doc lookup fails
    }

    log.info('[add-mix-comment] Received request:', { mixId, userName, userId, hasGif: !!gifUrl, hasAvatar: !!avatarUrl });

    if (!mixId || (!comment?.trim() && !gifUrl) || !userName?.trim()) {
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

    if (userName.trim().length > 30) {
      return ApiErrors.badRequest('Username must be 30 characters or less');
    }

    if (comment.trim().length > 300) {
      return ApiErrors.badRequest('Comment must be 300 characters or less');
    }

    const contentValidation = validateContent(comment);
    if (!contentValidation.valid) {
      return ApiErrors.badRequest(contentValidation.error);
    }

    const usernameValidation = validateContent(userName);
    if (!usernameValidation.valid) {
      return ApiErrors.badRequest('Username contains inappropriate content');
    }

    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      return ApiErrors.notFound('Mix not found');
    }

    const newComment = {
      id: 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      userId,
      userName: userName.trim(),
      avatarUrl: avatarUrl || null,
      comment: comment?.trim() || '',
      gifUrl: gifUrl || null,
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    log.info('[add-mix-comment] Adding comment:', newComment);

    // Use atomic arrayUnion to prevent lost comments under concurrent writes
    const currentCount = Array.isArray(mixData.comments) ? mixData.comments.length : 0;
    await arrayUnion('dj-mixes', mixId, 'comments', [newComment], {
      commentCount: currentCount + 1,
      updatedAt: new Date().toISOString()
    });

    // Dual-write to D1 (non-blocking)
    if (db) {
      try {
        await d1AddComment(db, {
          id: newComment.id,
          itemId: mixId,
          itemType: 'mix',
          userId: newComment.userId,
          userName: newComment.userName,
          avatarUrl: newComment.avatarUrl || undefined,
          comment: newComment.comment,
          gifUrl: newComment.gifUrl || undefined
        });
        log.info('[add-mix-comment] Also written to D1');
      } catch (d1Error: unknown) {
        log.error('[add-mix-comment] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Invalidate cache for this mix so fresh data is served
    clearCache(`doc:dj-mixes:${mixId}`);

    // Invalidate KV cache for mixes list so all edge workers serve fresh data
    const MIXES_CACHE = { prefix: 'mixes' };
    await kvDelete('public:50', MIXES_CACHE).catch(() => { /* KV cache invalidation — non-critical */ });
    await kvDelete('public:20', MIXES_CACHE).catch(() => { /* KV cache invalidation — non-critical */ });
    await kvDelete('public:100', MIXES_CACHE).catch(() => { /* KV cache invalidation — non-critical */ });

    log.info('[add-mix-comment] Comment saved');

    return successResponse({ comment: newComment, commentCount: currentCount + 1 }, 200, {
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
    });

  } catch (error: unknown) {
    log.error('[add-mix-comment] Error:', error);
    return ApiErrors.serverError('Failed to save comment');
  }
};