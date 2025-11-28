// src/pages/api/add-mix-comment.ts
// Stores comments as array within the dj-mix document (matching releases pattern)

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

// Profanity filter - common profane words (can be expanded)
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

// Check for profanity (handles common obfuscation like f*ck, f.u.c.k, etc)
function containsProfanity(text: string): { found: boolean; word?: string } {
  const normalizedText = text
    .toLowerCase()
    .replace(/[*@#$%!.]/g, '') // Remove common obfuscation chars
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/\s+/g, ' ');
  
  for (const word of PROFANITY_LIST) {
    // Check for whole word match
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(normalizedText)) {
      return { found: true, word };
    }
    // Check for word without spaces (e.g., "f u c k")
    const spacedWord = word.split('').join('\\s*');
    const spacedRegex = new RegExp(spacedWord, 'i');
    if (spacedRegex.test(normalizedText)) {
      return { found: true, word };
    }
  }
  return { found: false };
}

// Check for URLs/links
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

// Check for spam patterns
function containsSpam(text: string): { isSpam: boolean; reason?: string } {
  const lowerText = text.toLowerCase();
  
  // Check for excessive caps (more than 50% caps in text longer than 10 chars)
  if (text.length > 10) {
    const capsCount = (text.match(/[A-Z]/g) || []).length;
    const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && capsCount / letterCount > 0.5) {
      return { isSpam: true, reason: 'Excessive capital letters' };
    }
  }
  
  // Check for repeated characters (e.g., "heeeeelp")
  if (/(.)\1{4,}/i.test(text)) {
    return { isSpam: true, reason: 'Repeated characters' };
  }
  
  // Check for spam keywords
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
  
  // Check for phone numbers
  if (/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text)) {
    return { isSpam: true, reason: 'Phone numbers not allowed' };
  }
  
  // Check for email addresses
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    return { isSpam: true, reason: 'Email addresses not allowed' };
  }
  
  return { isSpam: false };
}

// Main content validation function
function validateContent(text: string): { valid: boolean; error?: string } {
  // Check for profanity
  const profanityCheck = containsProfanity(text);
  if (profanityCheck.found) {
    return { valid: false, error: 'Please keep comments clean and respectful' };
  }
  
  // Check for links
  if (containsLinks(text)) {
    return { valid: false, error: 'Links are not allowed in comments' };
  }
  
  // Check for spam
  const spamCheck = containsSpam(text);
  if (spamCheck.isSpam) {
    return { valid: false, error: spamCheck.reason || 'Comment flagged as spam' };
  }
  
  return { valid: true };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId, comment, userName, userId } = await request.json();

    console.log('[add-mix-comment] Received request:', { mixId, userName, userId });

    // Validate user is logged in
    if (!userId) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'You must be logged in to comment' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate inputs
    if (!mixId || !comment?.trim() || !userName?.trim()) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Missing required fields' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate lengths
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

    // Validate comment content (profanity, links, spam)
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

    // Also validate username
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

    // Get mix from Firebase
    const mixRef = db.collection('dj-mixes').doc(mixId);
    const mixDoc = await mixRef.get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Mix not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixData = mixDoc.data();

    // Initialize comments array if needed
    if (!mixData.comments) {
      mixData.comments = [];
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

    console.log('[add-mix-comment] Adding comment:', newComment);

    // Add comment to array
    mixData.comments.push(newComment);

    // Save to Firebase
    await mixRef.update({
      comments: mixData.comments,
      commentCount: mixData.comments.length,
      updatedAt: new Date().toISOString()
    });

    console.log('[add-mix-comment] ✓ Comment saved to Firebase');

    return new Response(JSON.stringify({
      success: true,
      comment: newComment,
      commentCount: mixData.comments.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[add-mix-comment] Error:', error);
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