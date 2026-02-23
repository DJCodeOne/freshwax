// src/pages/api/admin/fix-order-payout.ts
// Create missing pending payout for a specific order
// Usage: GET /api/admin/fix-order-payout/?orderId=xxx&confirm=yes

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { saSetDocument, saUpdateDocument, saQueryCollection, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('admin/fix-order-payout');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`fix-order-payout:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const orderId = url.searchParams.get('orderId');
  const confirm = url.searchParams.get('confirm');

  if (!orderId) {
    return ApiErrors.badRequest('Missing orderId');
  }

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  const serviceAccountKey = getServiceAccountKey(env);
  if (!serviceAccountKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  try {
    // Get order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    // Check if payout already exists for this order
    const existingPayouts = await saQueryCollection(serviceAccountKey, projectId, 'pendingPayouts', {
      filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
      limit: 1
    });

    if (existingPayouts.length > 0) {
      return jsonResponse({
        message: 'Payout already exists for this order',
        payout: existingPayouts[0]
      });
    }

    // Get release info for each digital item
    const digitalItems = (order.items || []).filter((item: Record<string, unknown>) =>
      item.type === 'digital' || item.type === 'release' || item.type === 'track'
    );

    if (digitalItems.length === 0) {
      return ApiErrors.badRequest('No digital items in order');
    }

    // Calculate payouts by artist
    const artistPayouts: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      amount: number;
      items: string[];
    }> = {};

    for (const item of digitalItems) {
      const releaseId = item.releaseId || item.productId || item.id;
      if (!releaseId) continue;

      const release = await getDocument('releases', releaseId);
      if (!release) continue;

      const artistId = release.submitterId || release.uploadedBy || release.userId;
      if (!artistId) continue;

      const itemTotal = (item.price || 0) * (item.quantity || 1);
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // Estimate processing fee (PayPal ~2.9% + £0.30)
      const processingFee = (itemTotal * 0.029) + 0.30;
      const artistShare = itemTotal - freshWaxFee - processingFee;

      if (!artistPayouts[artistId]) {
        artistPayouts[artistId] = {
          artistId,
          artistName: release.artistName || release.artist || 'Unknown Artist',
          artistEmail: release.email || release.artistEmail || release.submitterEmail || '',
          amount: 0,
          items: []
        };
      }

      artistPayouts[artistId].amount += artistShare;
      artistPayouts[artistId].items.push(item.title || item.name || 'Item');
    }

    if (Object.keys(artistPayouts).length === 0) {
      return ApiErrors.badRequest('Could not determine artist for any items');
    }

    if (confirm !== 'yes') {
      return jsonResponse({
        message: 'Would create the following payouts',
        payouts: Object.values(artistPayouts),
        usage: 'Add &confirm=yes to create'
      });
    }

    // Create pending payouts
    const created: Record<string, unknown>[] = [];
    const now = new Date().toISOString();

    for (const [artistId, payout] of Object.entries(artistPayouts)) {
      const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const payoutDoc = {
        artistId: payout.artistId,
        artistName: payout.artistName,
        artistEmail: payout.artistEmail,
        orderId,
        orderNumber: order.orderNumber,
        amount: Math.round(payout.amount * 100) / 100,
        itemAmount: Math.round(payout.amount * 100) / 100,
        currency: 'gbp',
        status: 'pending',
        payoutMethod: null,
        customerPaymentMethod: order.paymentMethod || 'paypal',
        items: payout.items,
        notes: 'Created via fix-order-payout',
        createdAt: now,
        updatedAt: now
      };

      await saSetDocument(serviceAccountKey, projectId, 'pendingPayouts', payoutId, payoutDoc);
      created.push({ payoutId, ...payoutDoc });

      // Update artist's pending balance
      try {
        const artist = await getDocument('artists', artistId);
        if (artist) {
          await saUpdateDocument(serviceAccountKey, projectId, 'artists', artistId, {
            pendingBalance: (artist.pendingBalance || 0) + payout.amount,
            updatedAt: now
          });
        }
      } catch (e: unknown) {
        log.info('[fix-order-payout] Could not update artist balance');
      }
    }

    // Also update ledger entry with artist info
    try {
      const ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
        filters: [{ field: 'orderId', op: 'EQUAL', value: orderId }],
        limit: 1
      });

      if (ledgerEntries.length > 0) {
        const firstArtist = Object.values(artistPayouts)[0];
        await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', ledgerEntries[0].id, {
          artistName: firstArtist.artistName,
          submitterEmail: firstArtist.artistEmail,
          artistPayout: firstArtist.amount,
          artistPayoutStatus: 'pending'
        });
      }
    } catch (e: unknown) {
      log.info('[fix-order-payout] Could not update ledger entry');
    }

    return successResponse({ message: `Created ${created.length} pending payout(s)`,
      payouts: created });

  } catch (error: unknown) {
    log.error('[fix-order-payout] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
