// src/pages/api/notify-restock.ts
// Back-in-stock notification system

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { addDocument, queryCollection, deleteDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors } from '../../lib/api-utils';

const NotifyRestockSchema = z.object({
  email: z.string().email('Invalid email address').max(320),
  productId: z.string().min(1, 'Product ID is required').max(200),
  productType: z.string().max(50).optional().default('merch'),
  productName: z.string().max(300).optional().default('Unknown Product'),
  variantKey: z.string().max(200).optional().nullable(),
});

const RestockDeleteSchema = z.object({
  email: z.string().email().max(320),
  productId: z.string().min(1).max(200),
});

export const prerender = false;

// POST - Subscribe to restock notification
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`notify-restock:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  try {
    const body = await request.json();
    const parsed = NotifyRestockSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { email, productId, productType, productName, variantKey } = parsed.data;

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

  } catch (error: unknown) {
    console.error('[notify-restock] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to subscribe to notifications');
  }
};

// DELETE - Unsubscribe from notifications
export const DELETE: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const parsed = RestockDeleteSchema.safeParse({
    email: url.searchParams.get('email') ?? '',
    productId: url.searchParams.get('productId') ?? '',
  });
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const { email, productId } = parsed.data;

  const env = locals.runtime.env;


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

  } catch (error: unknown) {
    console.error('[notify-restock] DELETE error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to unsubscribe');
  }
};
