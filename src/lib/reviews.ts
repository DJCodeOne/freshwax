// src/lib/reviews.ts
// Verified-purchase product reviews.
//
// Flow: review-requests cron emails buyers ~7 days after their order with a
// per-item tokenised link -> /review/ page -> POST /api/reviews. The token is
// an HMAC over (orderId, productId) so buyers can review WITHOUT logging in,
// but nobody can review a product they didn't buy (verified reviews only —
// this is what makes the aggregateRating schema legitimate).
//
// Storage: Firestore `productReviews` — one doc per (orderId, productId).
// Queried by productId only (single-field auto index; status filtered in
// process) to avoid the composite-index trap (see partner-approvals memory).

import { queryCollection } from './firebase-rest';

export interface ProductReview {
  id?: string;
  productId: string;
  productType: 'merch' | 'release' | 'other';
  orderId: string;
  orderNumber?: string;
  userName: string;
  rating: number; // 1-5
  comment?: string;
  status: 'published' | 'hidden';
  verified: boolean;
  createdAt: string;
}

function tokenSecret(env: Record<string, unknown> | undefined): string {
  return String(
    env?.REVIEW_TOKEN_SECRET || env?.CRON_SECRET ||
    import.meta.env.REVIEW_TOKEN_SECRET || import.meta.env.CRON_SECRET || ''
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Signed token for a (orderId, productId) review link. */
export async function reviewToken(
  env: Record<string, unknown> | undefined,
  orderId: string,
  productId: string
): Promise<string> {
  const secret = tokenSecret(env);
  if (!secret) throw new Error('Review token secret not configured');
  return (await hmacHex(secret, `review:${orderId}:${productId}`)).slice(0, 32);
}

export async function verifyReviewToken(
  env: Record<string, unknown> | undefined,
  orderId: string,
  productId: string,
  token: string
): Promise<boolean> {
  try {
    const expected = await reviewToken(env, orderId, productId);
    if (!token || token.length !== expected.length) return false;
    // timing-safe-ish comparison
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

/** Reviewable items from an order: store products only (merch + releases). */
export function reviewableOrderItems(order: Record<string, unknown>): Array<{
  productId: string;
  productType: 'merch' | 'release';
  name: string;
  image?: string;
}> {
  const items = (order.items || []) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const out: Array<{ productId: string; productType: 'merch' | 'release'; name: string; image?: string }> = [];
  for (const item of items) {
    if (item.isCratesItem === true) continue; // second-hand marketplace — seller items, not store products
    const type = String(item.type || '').toLowerCase();
    const isMerch = type.includes('merch') || String(item.productId || item.id || '').startsWith('merch_');
    const productId = String(
      (isMerch ? (item.productId || item.id) : (item.releaseId || item.productId || item.id)) || ''
    );
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    out.push({
      productId,
      productType: isMerch ? 'merch' : 'release',
      name: String(item.name || item.title || 'your order item'),
      image: (item.image || item.artwork) ? String(item.image || item.artwork) : undefined,
    });
  }
  return out;
}

/** Published reviews + aggregate for a product (single-equality query, no composite index). */
export async function getProductReviews(productId: string): Promise<{
  reviews: ProductReview[];
  average: number;
  count: number;
}> {
  const docs = await queryCollection('productReviews', {
    filters: [{ field: 'productId', op: 'EQUAL', value: productId }],
    limit: 100,
    cacheKey: `product-reviews:${productId}`,
    cacheTTL: 300000, // 5 min
  }).catch(() => [] as Record<string, unknown>[]);

  const reviews = (docs as unknown as ProductReview[])
    .filter((r) => r.status === 'published' && r.rating >= 1 && r.rating <= 5)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const count = reviews.length;
  const average = count ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
  return { reviews, average, count };
}
