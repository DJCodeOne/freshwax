// src/pages/api/cart.ts
// Cloudflare KV-backed cart storage
// Uses the CACHE KV namespace with cart:{userId} keys

import type { APIRoute } from 'astro';

export const prerender = false;

// Helper to get user ID from cookie or header
function getUserId(request: Request): string | null {
  // Check cookie first
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = cookieHeader.split(';').map(c => c.trim());

  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === 'customerId' && value) {
      return value;
    }
  }

  // Fallback to header
  return request.headers.get('X-User-Id');
}

// GET /api/cart - Retrieve cart from KV
export const GET: APIRoute = async ({ request, locals }) => {
  const userId = getUserId(request);

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
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE;

    if (!kv) {
      console.log('[Cart API] KV not available, returning empty cart');
      return new Response(JSON.stringify({
        success: true,
        cart: { items: [], updatedAt: null },
        source: 'fallback'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cartKey = `cart:${userId}`;
    const cartData = await kv.get(cartKey, 'json');

    console.log('[Cart API] GET', cartKey, cartData ? 'found' : 'empty');

    return new Response(JSON.stringify({
      success: true,
      cart: cartData || { items: [], updatedAt: null },
      source: 'kv'
    }), {
      headers: { 'Content-Type': 'application/json' }
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

// POST /api/cart - Save cart to KV
export const POST: APIRoute = async ({ request, locals }) => {
  const userId = getUserId(request);

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
    const { items } = body;

    if (!Array.isArray(items)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid cart data'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE;

    if (!kv) {
      console.log('[Cart API] KV not available, cart not persisted');
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

    console.log('[Cart API] POST', cartKey, 'saved', items.length, 'items');

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

// DELETE /api/cart - Clear cart from KV
export const DELETE: APIRoute = async ({ request, locals }) => {
  const userId = getUserId(request);

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
    const env = (locals as any)?.runtime?.env;
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

    console.log('[Cart API] DELETE', cartKey);

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
