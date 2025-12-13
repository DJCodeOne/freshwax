// src/pages/api/add-mix-comment.ts
// Stores comments as array within the dj-mix document (matching releases pattern)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, clearCache } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Profanity filter - common profane words
const PROFANITY_LIST = [
  'fuck', 'fucking', 'fucker', 'fucked', 'fucks', 'fuk', 'fck',
  'shit', 'shite', 'shitting', 'bullshit',
  'cunt', 'cunts',
  'cock', 'cocks', 'cocksucker',
  'dick', 'dicks', 'dickhead',
  'ass', 'arse', 'asshole', 'arsehole',
  'bitch', 'bitches', 'bitching',
  'bastard', 'bastards',
  'wanker', 'wankers', 'wank',
  'twat', 'twats',
  'piss', 'pissed', 'pissing',
  'slut', 'sluts', 'whore', 'whores',
  'nigger', 'nigga', 'negro',
  'faggot', 'fag', 'fags',
  'retard', 'retarded',
  'spastic', 'spaz',
  'bollocks', 'bellend',
  'tosser', 'tossers',
  'prick', 'pricks',
  'pussy', 'pussies'
];

function containsProfanity(text: string): { found: boolean; word?: string } {
  const normalizedText = text
    .toLowerCase()
    .replace(/[*@#$%!.]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/\s+/g, ' ');
  
  for (const word of PROFANITY_LIST) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(normalizedText)) {
      return { found: true, word };
    }
    const spacedWord = word.split('').join('\\s*');
    const spacedRegex = new RegExp(spacedWord, 'i');
    if (spacedRegex.test(normalizedText)) {
      return { found: true, word };
    }
  }
  return { found: false };
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId, comment, userName, userId, gifUrl, avatarUrl } = await request.json();

    log.info('[add-mix-comment] Received request:', { mixId, userName, userId, hasGif: !!gifUrl, hasAvatar: !!avatarUrl });

    if (!userId) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'You must be logged in to comment' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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