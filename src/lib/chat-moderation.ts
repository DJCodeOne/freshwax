// src/lib/chat-moderation.ts
// Content moderation for livestream chat — profanity filter and spam detection

// Common profanity list (lowercase) - catches most variations
// Words marked with _exact require exact word match (not substring)
const PROFANITY_EXACT = [
  'ass', 'arse', 'fag', 'piss', 'cock', 'dick', 'cum', 'tit', 'fuk',
];

const PROFANITY_SUBSTRING = [
  'fuck', 'fucker', 'fucking', 'fuckin', 'motherfuck',
  'shit', 'shite', 'shitty', 'bullshit',
  'cunt',
  'bitch', 'bitches',
  'bastard',
  'asshole', 'arsehole',
  'dickhead',
  'wanker', 'wank',
  'twat',
  'slut', 'whore',
  'nigger', 'nigga',
  'faggot',
  'retard', 'retarded',
  'scam', 'free money', 'click here', 'buy now',
  'cocaine', 'heroin',
];

// Normalize text for comparison (handle leetspeak and symbol substitutions)
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/\!/g, 'i')
    .replace(/\*/g, '')
    .replace(/[_\-\.]/g, '');
}

// Check if message contains profanity
function containsProfanity(message: string): boolean {
  const normalized = normalizeText(message);
  const words = normalized.split(/\s+/);

  for (const word of words) {
    if (PROFANITY_EXACT.includes(word)) {
      return true;
    }
  }

  for (const profane of PROFANITY_SUBSTRING) {
    if (normalized.includes(profane)) {
      return true;
    }
  }

  return false;
}

// Check for spam patterns
function isSpamMessage(message: string): { isSpam: boolean; reason?: string } {
  // Check for excessive caps (more than 70% uppercase and length > 10)
  if (message.length > 10) {
    const upperCount = (message.match(/[A-Z]/g) || []).length;
    const letterCount = (message.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && upperCount / letterCount > 0.7) {
      return { isSpam: true, reason: 'Please turn off caps lock' };
    }
  }

  // Check for repeated characters (aaaaaaa, !!!!!!!)
  if (/(.)\1{5,}/.test(message)) {
    return { isSpam: true, reason: 'Message contains too many repeated characters' };
  }

  // Check for repeated words (hello hello hello hello)
  const words = message.toLowerCase().split(/\s+/);
  if (words.length >= 4) {
    const wordCounts: Record<string, number> = {};
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
      if (wordCounts[word] >= 4) {
        return { isSpam: true, reason: 'Message contains too many repeated words' };
      }
    }
  }

  // Check for URLs (except common music platforms)
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urls = message.match(urlPattern) || [];
  for (const url of urls) {
    const lowerUrl = url.toLowerCase();
    const allowedDomains = ['youtube.com', 'youtu.be', 'soundcloud.com', 'vimeo.com', 'mixcloud.com', 'spotify.com'];
    const isAllowed = allowedDomains.some(domain => lowerUrl.includes(domain));
    if (!isAllowed) {
      return { isSpam: true, reason: 'Links are not allowed in chat' };
    }
  }

  return { isSpam: false };
}

// Main moderation function
export function moderateMessage(message: string): { allowed: boolean; reason?: string } {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: 'Message cannot be empty' };
  }

  if (containsProfanity(trimmed)) {
    return { allowed: false, reason: 'Please keep the chat friendly and respectful' };
  }

  const spamCheck = isSpamMessage(trimmed);
  if (spamCheck.isSpam) {
    return { allowed: false, reason: spamCheck.reason };
  }

  return { allowed: true };
}

// Web Crypto API helper for HMAC-SHA256 (hex output)
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBuffer = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
