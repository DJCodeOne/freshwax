// src/pages/api/delete-account.ts
// GDPR Article 17 compliant account deletion
// Purges PII from all Firestore collections, anonymizes financial records, cleans D1 and KV

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, deleteDocument, queryCollection, verifyUserToken } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const DeleteAccountSchema = z.object({
  userId: z.string().min(1, 'userId is required').max(200),
  idToken: z.string().min(1, 'Authentication required').max(5000),
});

const log = createLogger('delete-account');

export const prerender = false;

const ANON = '[deleted user]';
const REDACTED = '[redacted]';

interface DeletionResult {
  success: boolean;
  count?: number;
  error?: string;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);

  // Rate limit: destructive operation - 3 per hour
  const rateCheck = checkRateLimit(`delete-account:${clientId}`, RateLimiters.destructive);
  if (!rateCheck.allowed) {
    log.error(`[delete-account] Rate limit exceeded for ${clientId}`);
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const body = await request.json();
    const parsed = DeleteAccountSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId, idToken } = parsed.data;

    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only delete your own account');
    }

    log.info('[delete-account] Starting GDPR deletion for user:', userId);
    const timestamp = new Date().toISOString();
    const results: Record<string, DeletionResult> = {};

    // 1. Get user profile (need email for subscriber lookup)
    let userEmail = '';
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc) {
        userEmail = (userDoc.email || '').toLowerCase().trim();
      }
    } catch (e: unknown) {
      log.info('[delete-account] Could not fetch user doc for email lookup');
    }

    // 2. Delete user document
    results.users = await safeDelete('users', userId);

    // 3. Delete artist document
    results.artists = await safeDelete('artists', userId);

    // 4. Anonymize orders (keep for tax/legal, strip PII — Article 17(3)(b))
    results.orders = await anonymizeOrders(userId, timestamp);

    // 5. Anonymize comments (keep text, strip identity)
    results.comments = await anonymizeComments(userId);

    // 6. Delete subscriber record
    if (userEmail) {
      const subscriberId = userEmail.replace(/[.@]/g, '_');
      results.subscribers = await safeDelete('subscribers', subscriberId);
    }

    // 7. Delete DJ mixes (user-created content)
    results.djMixes = await deleteByQuery('dj-mixes', 'userId', userId);

    // 8. Delete vinyl listings
    results.vinylListings = await deleteByQuery('vinylListings', 'sellerId', userId);

    // 9. Delete vinyl seller profile
    results.vinylSellers = await safeDelete('vinylSellers', userId);

    // 10. Delete livestream bookings
    results.livestreamBookings = await deleteByQuery('livestream-bookings', 'userId', userId);

    // 11. Delete livestream slots
    results.livestreamSlots = await deleteByQuery('livestreamSlots', 'dj_id', userId);

    // 12. Delete DJ lobby bypass
    results.djLobbyBypass = await safeDelete('djLobbyBypass', userId);

    // 13. Delete pending PayPal orders
    results.pendingPayPalOrders = await safeDelete('pendingPayPalOrders', userId);

    // 14. D1 cleanup (anonymize financial, delete user-specific)
    if (env?.DB) {
      results.d1 = await cleanupD1(env.DB, userId, userEmail);
    }

    // 15. KV cache cleanup
    if (env?.CACHE) {
      results.kv = await cleanupKV(env.CACHE, userId);
    }

    log.info('[delete-account] Deletion complete:', JSON.stringify(results));

    // Check if at least user doc existed
    if (!results.users?.success && !results.artists?.success) {
      return ApiErrors.notFound('Account not found');
    }

    const safeDetails: Record<string, { success: boolean; count: number }> = {};
    for (const [key, value] of Object.entries(results)) {
      safeDetails[key] = { success: value.success, count: value.count || 0 };
    }
    return successResponse({ message: 'Account and all associated data have been permanently deleted.',
      details: safeDetails });

  } catch (error: unknown) {
    log.error('[delete-account] Error:', error);
    return ApiErrors.serverError('Failed to delete account');
  }
};

/** Delete a single document by collection/id, never throws */
async function safeDelete(collection: string, docId: string): Promise<DeletionResult> {
  try {
    const doc = await getDocument(collection, docId);
    if (!doc) return { success: true, count: 0 };
    await deleteDocument(collection, docId);
    return { success: true, count: 1 };
  } catch (e: unknown) {
    log.error(`[delete-account] Failed to delete ${collection}/${docId}:`, e);
    return { success: false, error: 'Deletion step failed' };
  }
}

/** Query documents by field and delete each one (parallel batch) */
async function deleteByQuery(collection: string, field: string, value: string): Promise<DeletionResult> {
  try {
    const docs = await queryCollection(collection, {
      filters: [{ field, op: 'EQUAL', value }],
      limit: 500,
      skipCache: true
    });
    const docIds = docs.map(doc => doc.id || doc.uid).filter(Boolean);
    if (docIds.length === 0) return { success: true, count: 0 };

    // Delete all documents in parallel instead of sequential N+1
    const results = await Promise.allSettled(
      docIds.map(docId => deleteDocument(collection, docId))
    );
    const count = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      log.error(`[delete-account] Failed to delete ${failed}/${docIds.length} docs from ${collection}`);
    }
    return { success: true, count };
  } catch (e: unknown) {
    log.error(`[delete-account] Failed to query/delete ${collection}:`, e);
    return { success: false, error: 'Deletion step failed' };
  }
}

/** Anonymize orders — keep financial data for tax/legal, strip all customer PII (parallel batch) */
async function anonymizeOrders(userId: string, timestamp: string): Promise<DeletionResult> {
  try {
    const orders = await queryCollection('orders', {
      filters: [{ field: 'customer.userId', op: 'EQUAL', value: userId }],
      limit: 500,
      skipCache: true
    });
    const orderIds = orders.map(order => order.id || order.uid).filter(Boolean);
    if (orderIds.length === 0) return { success: true, count: 0 };

    // Anonymize all orders in parallel instead of sequential N+1
    const results = await Promise.allSettled(
      orderIds.map(orderId =>
        updateDocument('orders', orderId, {
          customer: { userId: REDACTED, name: ANON, email: REDACTED },
          shipping: { name: ANON, address: {} },
          gdprAnonymized: true,
          gdprAnonymizedAt: timestamp
        })
      )
    );
    const count = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      log.error(`[delete-account] Failed to anonymize ${failed}/${orderIds.length} orders`);
    }
    return { success: true, count };
  } catch (e: unknown) {
    log.error('[delete-account] Failed to anonymize orders:', e);
    return { success: false, error: 'Deletion step failed' };
  }
}

/** Anonymize comments — keep text for community, strip user identity (parallel batch) */
async function anonymizeComments(userId: string): Promise<DeletionResult> {
  try {
    const comments = await queryCollection('comments', {
      filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
      limit: 500,
      skipCache: true
    });
    const commentIds = comments.map(comment => comment.id || comment.uid).filter(Boolean);
    if (commentIds.length === 0) return { success: true, count: 0 };

    // Anonymize all comments in parallel instead of sequential N+1
    const results = await Promise.allSettled(
      commentIds.map(commentId =>
        updateDocument('comments', commentId, {
          userId: '',
          userName: ANON,
          avatarUrl: '',
          gdprAnonymized: true
        })
      )
    );
    const count = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      log.error(`[delete-account] Failed to anonymize ${failed}/${commentIds.length} comments`);
    }
    return { success: true, count };
  } catch (e: unknown) {
    log.error('[delete-account] Failed to anonymize comments:', e);
    return { success: false, error: 'Deletion step failed' };
  }
}

/** Clean up D1 tables — anonymize financial records, delete user-specific data */
async function cleanupD1(db: Record<string, unknown>, userId: string, userEmail: string): Promise<DeletionResult> {
  try {
    let totalAffected = 0;

    // Anonymize comments
    const c1 = await db.prepare(
      `UPDATE comments SET user_name = ?, avatar_url = '', user_id = '' WHERE user_id = ?`
    ).bind(ANON, userId).run();
    totalAffected += c1?.meta?.changes || 0;

    // Delete user ratings
    const c2 = await db.prepare(
      `DELETE FROM user_ratings WHERE user_id = ?`
    ).bind(userId).run();
    totalAffected += c2?.meta?.changes || 0;

    // Anonymize sales ledger (keep financial data, strip PII)
    const c3 = await db.prepare(
      `UPDATE sales_ledger SET customer_id = ?, customer_email = ? WHERE customer_id = ?`
    ).bind(REDACTED, REDACTED, userId).run();
    totalAffected += c3?.meta?.changes || 0;

    // Delete DJ mixes
    const c4 = await db.prepare(
      `DELETE FROM dj_mixes WHERE user_id = ?`
    ).bind(userId).run();
    totalAffected += c4?.meta?.changes || 0;

    // Delete vinyl seller
    const c5 = await db.prepare(
      `DELETE FROM vinyl_sellers WHERE id = ?`
    ).bind(userId).run();
    totalAffected += c5?.meta?.changes || 0;

    return { success: true, count: totalAffected };
  } catch (e: unknown) {
    log.error('[delete-account] D1 cleanup failed:', e);
    return { success: false, error: 'Deletion step failed' };
  }
}

/** Delete KV cache entries for this user */
async function cleanupKV(cache: Record<string, unknown>, userId: string): Promise<DeletionResult> {
  try {
    // Delete known user cache keys
    const keys = [
      `user:${userId}`,
      `user:profile:${userId}`,
      `user:orders:${userId}`,
    ];
    for (const key of keys) {
      try { await cache.delete(key); } catch (e: unknown) { log.error('[delete-account] Failed to delete KV cache key:', key, e); }
    }
    return { success: true, count: keys.length };
  } catch (e: unknown) {
    log.error('[delete-account] KV cleanup failed:', e);
    return { success: false, error: 'Deletion step failed' };
  }
}
