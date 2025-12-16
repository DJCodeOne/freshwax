// src/lib/validation.ts
// Shared validation utilities

// Profanity filter - comprehensive list
const PROFANITY_LIST = [
  'fuck', 'fucking', 'fucker', 'fucked', 'fucks', 'fuk', 'fck', 'f**k',
  'shit', 'shite', 'shitting', 'bullshit', 'sh!t', 's**t',
  'cunt', 'cunts',
  'cock', 'cocks', 'cocksucker',
  'dick', 'dicks', 'dickhead',
  'ass', 'arse', 'asshole', 'arsehole', 'a$$',
  'bitch', 'bitches', 'bitching', 'b!tch', 'b**ch',
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
  'pussy', 'pussies',
  'damn', 'crap'
];

/**
 * Check if text contains profanity
 * @param text - Text to check
 * @returns Object with found status and optional matched word
 */
export function containsProfanity(text: string): { found: boolean; word?: string } {
  // Normalize text: lowercase, remove common substitutions
  const normalizedText = text
    .toLowerCase()
    .replace(/[*@#$%!.]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/\$/g, 's');

  for (const word of PROFANITY_LIST) {
    // Check for whole word matches (with word boundaries)
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(normalizedText)) {
      return { found: true, word };
    }
  }

  return { found: false };
}

/**
 * Validate text field for profanity
 * @param text - Text to validate
 * @param fieldName - Name of field for error message
 * @returns Validation result
 */
export function validateTextContent(text: string, fieldName: string = 'content'): { valid: boolean; error?: string } {
  if (!text || typeof text !== 'string') {
    return { valid: false, error: `${fieldName} is required` };
  }

  const profanityCheck = containsProfanity(text);
  if (profanityCheck.found) {
    return { valid: false, error: 'Please keep it clean - no profanity allowed' };
  }

  return { valid: true };
}

/**
 * Sanitize filename for safe storage
 * @param filename - Original filename
 * @param maxLength - Maximum allowed length
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string, maxLength: number = 100): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .substring(0, maxLength);
}

/**
 * Sanitize string for use in IDs/keys
 * @param str - Original string
 * @param maxLength - Maximum allowed length
 * @returns Sanitized string (alphanumeric only)
 */
export function sanitizeForId(str: string, maxLength: number = 30): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, maxLength);
}
