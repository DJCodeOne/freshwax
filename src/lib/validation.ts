// src/lib/validation.ts
// Shared validation utilities with Zod schemas
import { z } from 'zod';

// ============================================
// ZOD SCHEMAS FOR INPUT VALIDATION
// ============================================

// Sanitize string to prevent XSS
export function sanitizeString(str: string): string {
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// Common field schemas
export const emailSchema = z.string().email().max(255).transform(s => s.toLowerCase().trim());
export const nameSchema = z.string().min(1).max(100).transform(s => sanitizeString(s.trim()));
export const textSchema = z.string().max(1000).transform(s => sanitizeString(s.trim()));
export const longTextSchema = z.string().max(5000).transform(s => sanitizeString(s.trim()));
export const urlSchema = z.string().url().max(500).optional();
export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const adminKeySchema = z.string().min(1).max(128);

// Order schemas
export const customerSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  phone: z.string().max(20).optional(),
});

export const addressSchema = z.object({
  line1: z.string().min(1).max(200).transform(s => sanitizeString(s.trim())),
  line2: z.string().max(200).transform(s => sanitizeString(s.trim())).optional(),
  city: z.string().min(1).max(100).transform(s => sanitizeString(s.trim())),
  postcode: z.string().min(1).max(20).transform(s => sanitizeString(s.trim())),
  country: z.string().min(2).max(2).default('GB'),
});

export const orderItemSchema = z.object({
  id: idSchema,
  type: z.enum(['release', 'merch', 'giftcard']),
  title: z.string().max(200),
  quantity: z.number().int().min(1).max(100),
  price: z.number().min(0).max(10000),
  artistId: idSchema.optional(),
  size: z.string().max(10).optional(),
  color: z.string().max(50).optional(),
});

export const createOrderSchema = z.object({
  customer: customerSchema,
  shipping: addressSchema,
  items: z.array(orderItemSchema).min(1).max(50),
  giftCardCode: z.string().max(50).optional(),
  notes: textSchema.optional(),
});

// DJ Mix schemas
export const djMixSchema = z.object({
  title: z.string().min(1).max(200).transform(s => sanitizeString(s.trim())),
  djName: z.string().min(1).max(100).transform(s => sanitizeString(s.trim())),
  genre: z.string().max(50).transform(s => sanitizeString(s.trim())).optional(),
  description: longTextSchema.optional(),
  tracklist: longTextSchema.optional(),
  userId: idSchema,
});

// Livestream schemas
export const livestreamSlotSchema = z.object({
  djId: idSchema,
  djName: z.string().min(1).max(100).transform(s => sanitizeString(s.trim())),
  title: z.string().min(1).max(200).transform(s => sanitizeString(s.trim())),
  genre: z.string().max(50).transform(s => sanitizeString(s.trim())).optional(),
  startTime: z.string(),
  endTime: z.string(),
});

export const chatMessageSchema = z.object({
  userId: idSchema,
  userName: z.string().min(1).max(50).transform(s => sanitizeString(s.trim())),
  message: z.string().min(1).max(500).transform(s => sanitizeString(s.trim())),
  isGif: z.boolean().optional(),
});

// Admin schemas
export const bypassGrantSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  email: emailSchema.optional(),
  userId: idSchema.optional(),
  reason: textSchema.optional(),
  adminKey: adminKeySchema,
});

export const moderationSchema = z.object({
  action: z.enum(['ban', 'unban', 'hold', 'release', 'kick']),
  email: emailSchema.optional(),
  userId: idSchema.optional(),
  reason: textSchema.optional(),
  adminKey: adminKeySchema,
});

// Validation helper
export function validateRequest<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
  return { success: false, error: `Validation failed: ${errors}` };
}

// ============================================
// PROFANITY FILTER
// ============================================

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
