// src/pages/api/notify-restock.ts
// Back-in-stock notification system

import type { APIRoute } from 'astro';
import { addDocument, queryCollection, deleteDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

// POST - Subscribe to restock notification
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`notify-restock:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { email, productId, productType, productName, variantKey } = body;

    if (!email || !productId) {
      return new Response(JSON.stringify({
        error: 'Email and product ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({
        error: 'Invalid email address'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if already subscribed
    const existing = await queryCollection('restockNotifications', {
      filters: [
        { field: 'email', op: 'EQUAL', value: email.toLowerCase() },
        { field: 'productId', op: 'EQUAL', value: productId },
        { field: 'variantKey', op: 'EQUAL', value: variantKey || null }
      ],
      limit: 1
    });

    if (existing.length > 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'Already subscribed to notifications for this item'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Create subscription
    await addDocument('restockNotifications', {
      email: email.toLowerCase(),
      productId,
      productType: productType || 'merch',
      productName: productName || 'Unknown Product',
      variantKey: variantKey || null,
      status: 'active',
      createdAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'You will be notified when this item is back in stock'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[notify-restock] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to subscribe to notifications'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE - Unsubscribe from notifications
export const DELETE: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const email = url.searchParams.get('email');
  const productId = url.searchParams.get('productId');

  if (!email || !productId) {
    return new Response(JSON.stringify({
      error: 'Email and product ID required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const subscriptions = await queryCollection('restockNotifications', {
      filters: [
        { field: 'email', op: 'EQUAL', value: email.toLowerCase() },
        { field: 'productId', op: 'EQUAL', value: productId }
      ],
      limit: 10
    });

    for (const sub of subscriptions) {
      await deleteDocument('restockNotifications', sub.id);
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Unsubscribed from notifications'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[notify-restock] DELETE error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to unsubscribe'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
