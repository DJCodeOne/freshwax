// src/pages/api/cart.ts
// Cloudflare KV-backed cart storage
// Uses the CACHE KV namespace with cart:{userId} keys

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../lib/firebase-rest';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const log = createLogger('cart');

const CartItemSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(500).optional(),
  price: z.number().min(0).optional(),
  quantity: z.number().int().min(1).max(100).optional(),
  type: z.string().max(100).optional(),
  image: z.string().max(2000).optional(),
  artwork: z.string().max(2000).optional(),
  artist: z.string().max(200).optional(),
  artistId: z.string().max(200).optional(),
  releaseId: z.string().max(200).optional(),
  productId: z.string().max(200).optional(),
  trackId: z.string().max(200).optional(),
  size: z.string().max(50).optional(),
  color: z.union([z.string().max(100), z.object({ name: z.string().max(100), hex: z.string().max(20) })]).optional(),
  format: z.string().max(50).optional(),
}).strip();

const CartSaveSchema = z.object({
  items: z.array(CartItemSchema).max(100),
});

export const prerender = false;

// Helper to get user ID - prefers verified Firebase auth, falls back to customerId cookie
async function getUserId(request: Request, locals: App.Locals): Promise<string | null> {
  // Try Firebase auth first (secure, verified identity)
  try {
    const { userId: verifiedUserId } = await verifyRequestUser(request);
    if (verifiedUserId) return verifiedUserId;
  } catch (e: unknown) {
    // No auth token - fall through to cookie
  }

  // Fallback to customerId cookie (set at login, scoped to same user)
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = cookieHeader.split(';').map(c => c.trim());

  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === 'customerId' && value) {
      return value;
    }
  }

  return null;
}

// GET /api/cart/ - Retrieve cart from KV
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`cart-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const userId = await getUserId(request, locals);

  if (!userId) {
    return ApiErrors.unauthorized('Not authenticated');
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE;

    if (!kv) {
      log.info('[Cart API] KV not available, returning empty cart');
      return successResponse({ cart: { items: [], updatedAt: null }, source: 'fallback' }, 200, {
        headers: { 'Cache-Control': 'private, no-store' }
      });
    }

    const cartKey = `cart:${userId}`;
    const cartData = await kv.get(cartKey, 'json');

    log.info('[Cart API] GET', cartKey, cartData ? 'found' : 'empty');

    return successResponse({ cart: cartData || { items: [], updatedAt: null }, source: 'kv' }, 200, {
      headers: { 'Cache-Control': 'private, no-store' }
    });

  } catch (error: unknown) {
    log.error('[Cart API] GET error:', error);
    return ApiErrors.serverError('Failed to retrieve cart');
  }
};

// POST /api/cart/ - Save cart to KV
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitPost = checkRateLimit(`cart-post:${clientId}`, RateLimiters.standard);
  if (!rateLimitPost.allowed) {
    return rateLimitResponse(rateLimitPost.retryAfter!);
  }

  const userId = await getUserId(request, locals);

  if (!userId) {
    return ApiErrors.unauthorized('Not authenticated');
  }

  try {
    const body = await request.json();
    const parsed = CartSaveSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid cart data');
    }
    const { items } = parsed.data;

    const env = locals.runtime.env;
    const kv = env?.CACHE;

    if (!kv) {
      log.info('[Cart API] KV not available, cart not persisted');
      return successResponse({ persisted: false, message: 'KV not available' });
    }

    const cartKey = `cart:${userId}`;
    const cartData = {
      items,
      updatedAt: new Date().toISOString()
    };

    // Store with 30 day expiration (in seconds)
    await kv.put(cartKey, JSON.stringify(cartData), {
      expirationTtl: 30 * 24 * 60 * 60
    });

    log.info('[Cart API] POST', cartKey, 'saved', items.length, 'items');

    return successResponse({ persisted: true, itemCount: items.length });

  } catch (error: unknown) {
    log.error('[Cart API] POST error:', error);
    return ApiErrors.serverError('Failed to save cart');
  }
};

// DELETE /api/cart/ - Clear cart from KV
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitDelete = checkRateLimit(`cart-delete:${clientId}`, RateLimiters.standard);
  if (!rateLimitDelete.allowed) {
    return rateLimitResponse(rateLimitDelete.retryAfter!);
  }

  const userId = await getUserId(request, locals);

  if (!userId) {
    return ApiErrors.unauthorized('Not authenticated');
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE;

    if (!kv) {
      return successResponse({ message: 'KV not available' });
    }

    const cartKey = `cart:${userId}`;
    await kv.delete(cartKey);

    log.info('[Cart API] DELETE', cartKey);

    return successResponse({} as Record<string, unknown>);

  } catch (error: unknown) {
    log.error('[Cart API] DELETE error:', error);
    return ApiErrors.serverError('Failed to clear cart');
  }
};
