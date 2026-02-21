// src/pages/api/save-user-badge.ts
// Save user's Plus badge to KV storage (minimal Firebase usage)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, verifyUserToken } from '../../lib/firebase-rest';
import { errorResponse, ApiErrors } from '../../lib/api-utils';

export const prerender = false;

// KV key for user badge
const getBadgeKey = (userId: string) => `plus-badge:${userId}`;

// Valid badge options
const VALID_BADGES = [
  'crown', 'fire', 'headphones', 'skull', 'lion', 'leopard', 'palm', 'lightning',
  'vinyl', 'speaker', 'moon', 'star', 'diamond', 'snake', 'bat', 'mic', 'leaf',
  'gorilla', 'spider', 'alien'
] as const;

const SaveBadgeSchema = z.object({
  userId: z.string().min(1, 'Missing userId').max(200),
  badge: z.enum(VALID_BADGES, { message: 'Invalid badge' }),
});

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    if (!kv) {
      return errorResponse('Storage not available', 503);
    }

    // Get auth token
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;

    const rawBody = await request.json();
    const parsed = SaveBadgeSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId, badge } = parsed.data;

    // Require auth token
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Verify the token matches the userId
    try {
      const tokenUserId = await verifyUserToken(idToken);
      if (tokenUserId !== userId) {
        return ApiErrors.forbidden('User mismatch');
      }
    } catch (e: unknown) {
      console.error('[save-user-badge] Token verification failed:', e);
      return ApiErrors.unauthorized('Invalid authentication token');
    }

    // Check if user is Plus member (this is the only Firebase read - on save only)
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return ApiErrors.notFound('User not found');
    }

    let isPro = false;
    if (userDoc.subscription?.tier === 'pro') {
      const expiresAt = userDoc.subscription.expiresAt;
      if (expiresAt) {
        const expiryDate = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
        isPro = expiryDate > new Date();
      }
    }

    if (!isPro) {
      return ApiErrors.forbidden('Only Plus members can customize their badge');
    }

    // Save badge to KV (no Firebase write, no quota impact)
    await kv.put(getBadgeKey(userId), badge, {
      expirationTtl: 365 * 24 * 60 * 60 // 1 year TTL
    });

    return new Response(JSON.stringify({
      success: true,
      badge
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[save-user-badge] Error:', error);
    return ApiErrors.serverError('Failed to save badge');
  }
};
