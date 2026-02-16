// src/pages/api/cart.ts
// Cloudflare KV-backed cart storage
// Uses the CACHE KV namespace with cart:{userId} keys

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../lib/firebase-rest';

const CartItemSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(500).optional(),
  price: z.number().min(0).optional(),
  quantity: z.number().int().min(1).max(100).optional(),
}).catchall(z.unknown());

const CartSaveSchema = z.object({
  items: z.array(CartItemSchema).max(100),
});

export const prerender = false;

const isDev = import.meta.env.DEV;

// Helper to get user ID - prefers verified Firebase auth, falls back to cookie for anonymous carts (GET only)
async function getUserId(request: Request, locals: App.Locals): Promise<string | null> {
  // Try Firebase auth first (secure, verified identity)
  try {
    const env = locals.runtime.env;
    const { userId: verifiedUserId } = await verifyRequestUser(request);
    if (verifiedUserId) return verifiedUserId;
  } catch {
    // No auth token - fall through to cookie for GET requests only
  }

  // Cookie fallback only allowed for GET (read-only) requests to prevent IDOR on writes
  if (request.method !== 'GET') {
    return null;
  }

  // Fallback to cookie for anonymous/pre-auth cart persistence (GET only)
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
  const userId = await getUserId(request, locals);

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Not authenticated'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE;

    if (!kv) {
      if (isDev) console.log('[Cart API] KV not available, returning empty cart');
      return new Response(JSON.stringify({
        success: true,
        cart: { items: [], updatedAt: null },
        source: 'fallback'
      }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
      });
    }

    const cartKey = `cart:${userId}`;
    const cartData = await kv.get(cartKey, 'json');

    if (isDev) console.log('[Cart API] GET', cartKey, cartData ? 'found' : 'empty');

    return new Response(JSON.stringify({
      success: true,
      cart: cartData || { items: [], updatedAt: null },
      source: 'kv'
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
    });

  } catch (error) {
    console.error('[Cart API] GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to retrieve cart'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST /api/cart/ - Save cart to KV
export const POST: APIRoute = async ({ request, locals }) => {
  const userId = await getUserId(request, locals);

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Not authenticated'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await request.json();
    const parsed = CartSaveSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid cart data',
        details: parsed.error.issues.map(i => i.message)
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const { items } = parsed.data;

    const env = locals.runtime.env;
    const kv = env?.CACHE;

    if (!kv) {
      if (isDev) console.log('[Cart API] KV not available, cart not persisted');
      return new Response(JSON.stringify({
        success: true,
        persisted: false,
        message: 'KV not available'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
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

    if (isDev) console.log('[Cart API] POST', cartKey, 'saved', items.length, 'items');

    return new Response(JSON.stringify({
      success: true,
      persisted: true,
      itemCount: items.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Cart API] POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to save cart'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE /api/cart/ - Clear cart from KV
export const DELETE: APIRoute = async ({ request, locals }) => {
  const userId = await getUserId(request, locals);

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Not authenticated'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE;

    if (!kv) {
      return new Response(JSON.stringify({
        success: true,
        message: 'KV not available'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cartKey = `cart:${userId}`;
    await kv.delete(cartKey);

    if (isDev) console.log('[Cart API] DELETE', cartKey);

    return new Response(JSON.stringify({
      success: true
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Cart API] DELETE error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to clear cart'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
