// src/pages/api/add-mix-comment.ts
// Stores comments as array within the dj-mix document (matching releases pattern)
// Dual-write: Firebase + D1

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, clearCache, initFirebaseEnv } from '../../lib/firebase-rest';
import { containsProfanity } from '../../lib/validation';
import { d1AddComment } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Initialize Firebase helper
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

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

  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You must be logged in to comment'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { mixId, comment, userName, gifUrl, avatarUrl } = await request.json();

    log.info('[add-mix-comment] Received request:', { mixId, userName, userId, hasGif: !!gifUrl, hasAvatar: !!avatarUrl });

    if (!mixId || (!comment?.trim() && !gifUrl) || !userName?.trim()) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Missing required fields' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate gifUrl if provided (must be from Giphy)
    if (gifUrl && !gifUrl.includes('giphy.com')) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Invalid GIF URL' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (userName.trim().length > 30) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Username must be 30 characters or less' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (comment.trim().length > 300) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Comment must be 300 characters or less' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const contentValidation = validateContent(comment);
    if (!contentValidation.valid) {
      return new Response(JSON.stringify({ 
        success: false,
        error: contentValidation.error 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const usernameValidation = validateContent(userName);
    if (!usernameValidation.valid) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Username contains inappropriate content' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!mixData.comments) {
      mixData.comments = [];
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

    mixData.comments.push(newComment);

    await updateDocument('dj-mixes', mixId, {
      comments: mixData.comments,
      commentCount: mixData.comments.length,
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
      } catch (d1Error) {
        log.error('[add-mix-comment] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Invalidate cache for this mix so fresh data is served
    clearCache(`doc:dj-mixes:${mixId}`);

    log.info('[add-mix-comment] Comment saved');

    return new Response(JSON.stringify({
      success: true,
      comment: newComment,
      commentCount: mixData.comments.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

  } catch (error) {
    log.error('[add-mix-comment] Error:', error);
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