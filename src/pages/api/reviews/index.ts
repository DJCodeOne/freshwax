// src/pages/api/reviews/index.ts
// POST: submit a verified-purchase review (tokenised link from the review
//       request email — no login required, but the HMAC token proves the
//       reviewer bought the product; see src/lib/reviews.ts).
// GET:  published reviews + aggregate for a product (public, cached).

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, addDocument, queryCollection } from '../../../lib/firebase-rest';
import { verifyReviewToken, reviewableOrderItems, getProductReviews } from '../../../lib/reviews';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, errorResponse, successResponse, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('[reviews]');

export const prerender = false;

const SubmitSchema = z.object({
  orderId: z.string().min(1).max(200),
  productId: z.string().min(1).max(200),
  token: z.string().min(16).max(64),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(600).optional(),
  name: z.string().max(60).optional(),
}).strip();

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`review-submit:${clientId}`, {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals?.runtime?.env;

  try {
    const parseResult = SubmitSchema.safeParse(await request.json().catch(() => null));
    if (!parseResult.success) return ApiErrors.badRequest('Invalid review');
    const { orderId, productId, token, rating, comment, name } = parseResult.data;

    // 1. Token must match this exact (order, product) pair
    if (!(await verifyReviewToken(env, orderId, productId, token))) {
      return ApiErrors.forbidden('Invalid review link');
    }

    // 2. The order must exist and actually contain the product
    const order = await getDocument('orders', orderId);
    if (!order) return ApiErrors.notFound('Order not found');
    const item = reviewableOrderItems(order).find((i) => i.productId === productId);
    if (!item) return ApiErrors.badRequest('This product is not part of that order');

    // 3. One review per (order, product)
    const existing = await queryCollection('productReviews', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 50,
      skipCache: true,
    }).catch(() => [] as Record<string, unknown>[]);
    if (existing.some((r) => r.productId === productId)) {
      return errorResponse('You have already reviewed this item — thank you!', 409);
    }

    const customer = (order.customer || {}) as Record<string, unknown>;
    const fallbackName = String(customer.firstName || 'Verified buyer');

    await addDocument('productReviews', {
      productId,
      productType: item.productType,
      productName: item.name,
      orderId,
      orderNumber: String(order.orderNumber || ''),
      userName: (name || fallbackName).trim().slice(0, 60) || 'Verified buyer',
      rating,
      comment: (comment || '').trim().slice(0, 600),
      status: 'published',
      verified: true,
      createdAt: new Date().toISOString(),
    });

    log.info(`Review stored: ${item.productType} ${productId} ${rating}★ (order ${order.orderNumber})`);
    return successResponse({ message: 'Review published — thank you!' });
  } catch (error: unknown) {
    log.error('Submit error:', error);
    return errorResponse('Failed to save review', 500);
  }
};

export const GET: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`review-list:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const productId = new URL(request.url).searchParams.get('productId');
  if (!productId) return ApiErrors.badRequest('productId required');

  const { reviews, average, count } = await getProductReviews(productId);
  return jsonResponse(
    {
      success: true,
      average,
      count,
      reviews: reviews.slice(0, 20).map((r) => ({
        userName: r.userName,
        rating: r.rating,
        comment: r.comment || '',
        createdAt: r.createdAt,
        verified: r.verified === true,
      })),
    },
    200,
    { headers: { 'Cache-Control': 'public, max-age=300' } }
  );
};
