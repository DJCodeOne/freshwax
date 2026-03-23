// src/pages/api/admin/backfill-ledger.ts
// Backfill sales ledger entries for orders missing them
// Run via: GET /api/admin/backfill-ledger/?confirm=yes

import type { APIRoute } from 'astro';

import { saSetDocument, saQueryCollection, saGetDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/backfill-ledger');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`backfill-ledger:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const runtimeEnv = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: runtimeEnv?.ADMIN_UIDS, ADMIN_EMAILS: runtimeEnv?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm');
  const dryRun = confirm !== 'yes';

  // Get service account credentials
  const projectId = runtimeEnv?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = runtimeEnv?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = runtimeEnv?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return ApiErrors.serverError('Firebase service account not configured');
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail
  });

  try {
    // Get all orders and ledger entries using service account
    let ordersData: Record<string, unknown>[] = [];
    let ledgerData: Record<string, unknown>[] = [];

    try {
      ordersData = await saQueryCollection(serviceAccountKey, projectId, 'orders', { limit: 500 });
      log.info('[backfill] Got', ordersData.length, 'orders from SA query');
    } catch (ordersErr: unknown) {
      log.error('[backfill] Orders query failed:', ordersErr);
      return ApiErrors.serverError('Orders query failed: ');
    }

    try {
      ledgerData = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', { limit: 500 });
      log.info('[backfill] Got', ledgerData.length, 'ledger entries from SA query');
    } catch (ledgerErr: unknown) {
      log.info('[backfill] Ledger query failed (may not exist yet):', ledgerErr);
      // Ledger might not exist yet - continue with empty
      ledgerData = [];
    }

    // Find orders that already have ledger entries
    const ordersWithLedger = new Set(ledgerData.map((e: Record<string, unknown>) => e.orderId));

    const results: Record<string, unknown>[] = [];
    let totalCreated = 0;
    let totalSkipped = 0;

    // --- Batch-fetch: collect all unique document IDs first ---
    const releaseIdsToFetch = new Set<string>();
    const merchIdsToFetch = new Set<string>();

    for (const order of ordersData) {
      if (ordersWithLedger.has(order.id)) continue;
      if (order.paymentMethod === 'test_mode' || order.status === 'cancelled') continue;
      const items = order.items || [];
      for (const item of items) {
        const hasSubmitter = item.artistId || item.submitterId;
        const releaseId = item.releaseId || item.productId || item.id;
        if (!hasSubmitter && releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || !item.type)) {
          releaseIdsToFetch.add(releaseId);
        }
        if (!hasSubmitter && item.productId && item.type === 'merch') {
          merchIdsToFetch.add(item.productId);
        }
      }
    }

    // Batch fetch releases and merch in parallel
    const releaseMap = new Map<string, Record<string, unknown>>();
    const merchMap = new Map<string, Record<string, unknown>>();

    const fetchPromises: Promise<void>[] = [];

    for (const id of releaseIdsToFetch) {
      fetchPromises.push(
        saGetDocument(serviceAccountKey, projectId, 'releases', id)
          .then((doc) => { if (doc) releaseMap.set(id, doc); })
          .catch(() => { /* Ignore lookup errors */ })
      );
    }
    for (const id of merchIdsToFetch) {
      fetchPromises.push(
        saGetDocument(serviceAccountKey, projectId, 'merch', id)
          .then((doc) => { if (doc) merchMap.set(id, doc); })
          .catch(() => { /* Ignore lookup errors */ })
      );
    }

    const fetchResults = await Promise.allSettled(fetchPromises);
    const fetchFailed = fetchResults.filter(r => r.status === 'rejected').length;
    if (fetchFailed > 0) {
      log.warn(`[backfill] ${fetchFailed} release/merch lookups failed`);
    }

    // Now batch-fetch artist docs for all submitterIds found in releases
    const artistIdsToFetch = new Set<string>();
    for (const release of releaseMap.values()) {
      const sid = release.submitterId || release.uploadedBy || release.userId;
      if (sid && typeof sid === 'string') artistIdsToFetch.add(sid);
    }

    const artistMap = new Map<string, Record<string, unknown>>();
    const artistFetchPromises: Promise<void>[] = [];
    for (const id of artistIdsToFetch) {
      artistFetchPromises.push(
        saGetDocument(serviceAccountKey, projectId, 'artists', id)
          .then((doc) => { if (doc) artistMap.set(id, doc); })
          .catch(() => { /* Ignore lookup errors */ })
      );
    }
    const artistResults = await Promise.allSettled(artistFetchPromises);
    const artistFetchFailed = artistResults.filter(r => r.status === 'rejected').length;
    if (artistFetchFailed > 0) {
      log.warn(`[backfill] ${artistFetchFailed} artist lookups failed`);
    }

    log.info(`[backfill] Pre-fetched ${releaseMap.size} releases, ${merchMap.size} merch, ${artistMap.size} artists`);

    // --- Process each order using pre-fetched maps ---
    for (const order of ordersData) {
      // Skip if already has ledger entry
      if (ordersWithLedger.has(order.id)) {
        results.push({ orderId: order.id, status: 'skipped', reason: 'Already has ledger entry' });
        totalSkipped++;
        continue;
      }

      // Skip test/cancelled orders
      if (order.paymentMethod === 'test_mode' || order.status === 'cancelled') {
        results.push({ orderId: order.id, status: 'skipped', reason: `test_mode or cancelled: ${order.paymentMethod} / ${order.status}` });
        totalSkipped++;
        continue;
      }

      // Skip orders with no items
      const items = order.items || [];
      if (items.length === 0) {
        results.push({ orderId: order.id, status: 'skipped', reason: 'No items' });
        totalSkipped++;
        continue;
      }

      // Process each item using pre-fetched data
      for (const item of items) {
        let submitterId = item.artistId || item.submitterId || null;
        let submitterEmail = item.artistEmail || item.submitterEmail || null;
        let artistName = item.artist || item.artistName || null;

        // Try to look up release for digital items
        const releaseId = item.releaseId || item.productId || item.id;
        if (!submitterId && releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || !item.type)) {
          const release = releaseMap.get(releaseId);
          if (release) {
            submitterId = release.submitterId || release.uploadedBy || release.userId || null;
            submitterEmail = release.email || release.submitterEmail || null;
            artistName = release.submittedBy || release.artistName || release.artist || artistName;

            // Look up the artist/user document from pre-fetched map
            if (submitterId) {
              const artist = artistMap.get(submitterId as string);
              if (artist?.name || artist?.displayName) {
                artistName = artist.displayName || artist.name;
              }
            }
          }
        }

        // Try to look up merch from pre-fetched map
        if (!submitterId && item.productId && item.type === 'merch') {
          const merch = merchMap.get(item.productId);
          if (merch) {
            submitterId = merch.supplierId || merch.sellerId || merch.userId || null;
            submitterEmail = merch.email || merch.sellerEmail || null;
            artistName = merch.sellerName || merch.supplierName || artistName;
          }
        }

        // Skip if still no seller
        if (!submitterId) {
          results.push({
            orderId: order.id,
            item: item.title || item.name,
            status: 'skipped',
            reason: 'No seller found'
          });
          continue;
        }

        // Calculate payout using actual fees from order
        const itemPrice = (item.price || 0) * (item.quantity || 1);

        // Skip free items (no payout needed)
        if (itemPrice <= 0) {
          results.push({
            orderId: order.id,
            item: item.title || item.name,
            status: 'skipped',
            reason: 'Free item (£0)'
          });
          continue;
        }

        // Use actual fees from order if available
        const freshWaxFee = order.totals?.freshWaxFee || (itemPrice * 0.01);
        const paypalFee = order.paypalFee || order.actualPaypalFee || 0;
        const stripeFee = order.totals?.stripeFee || 0;

        // If no fees recorded, estimate based on payment method
        let totalFees = freshWaxFee + paypalFee + stripeFee;
        if (totalFees === freshWaxFee && order.paymentMethod === 'stripe') {
          // Estimate Stripe fee if not recorded
          totalFees = freshWaxFee + (itemPrice * 0.015 + 0.20);
        } else if (totalFees === freshWaxFee && order.paymentMethod === 'paypal') {
          // Estimate PayPal fee if not recorded (2.9% + £0.30)
          totalFees = freshWaxFee + (itemPrice * 0.029 + 0.30);
        }

        const artistPayout = Math.round((itemPrice - totalFees) * 100) / 100;

        // Skip if payout would be negative
        if (artistPayout <= 0) {
          results.push({
            orderId: order.id,
            item: item.title || item.name,
            status: 'skipped',
            reason: `Negative payout (£${artistPayout})`
          });
          continue;
        }

        // Create ledger entry
        const now = new Date(order.createdAt || Date.now());
        const ledgerEntry = {
          orderId: order.id,
          orderNumber: order.orderNumber || '',
          timestamp: now.toISOString(),
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          day: now.getDate(),
          customerId: order.customer?.userId || null,
          customerEmail: order.customer?.email || '',
          artistId: submitterId,
          artistName: artistName,
          submitterId: submitterId,
          submitterEmail: submitterEmail,
          subtotal: itemPrice,
          shipping: 0,
          discount: 0,
          grossTotal: itemPrice,
          stripeFee: Math.round(stripeFee * 100) / 100,
          paypalFee: Math.round(paypalFee * 100) / 100,
          freshWaxFee: Math.round(freshWaxFee * 100) / 100,
          totalFees: Math.round(totalFees * 100) / 100,
          netRevenue: artistPayout,
          artistPayout: artistPayout,
          artistPayoutStatus: 'pending',
          paymentMethod: order.paymentMethod || 'stripe',
          paymentId: order.paymentIntentId || null,
          currency: 'GBP',
          itemCount: 1,
          hasPhysical: item.type === 'merch' || item.type === 'vinyl',
          hasDigital: item.type === 'digital' || item.type === 'release' || item.type === 'track',
          items: [{
            type: item.type || 'release',
            id: releaseId || '',
            title: item.title || item.name || 'Unknown',
            artist: artistName,
            quantity: item.quantity || 1,
            unitPrice: item.price || 0,
            lineTotal: itemPrice
          }],
          backfilledAt: new Date().toISOString()
        };

        if (dryRun) {
          results.push({
            orderId: order.id,
            item: item.title || item.name,
            artistId: submitterId,
            artistName: artistName,
            artistPayout: artistPayout,
            status: 'would_create'
          });
        } else {
          try {
            // Generate ledger ID
            const ledgerId = `ledger_${order.id}_${submitterId.slice(-6)}`;
            await saSetDocument(serviceAccountKey, projectId, 'salesLedger', ledgerId, ledgerEntry);
            results.push({
              orderId: order.id,
              item: item.title || item.name,
              artistId: submitterId,
              artistPayout: artistPayout,
              ledgerId: ledgerId,
              status: 'created'
            });
            totalCreated++;
          } catch (writeErr: unknown) {
            log.error(`[backfill] Failed to write ledger for order ${order.id}:`, writeErr);
            results.push({
              orderId: order.id,
              item: item.title || item.name,
              status: 'error',
              error: 'Ledger write failed'
            });
          }
        }
      }
    }

    return successResponse({ dryRun,
      message: dryRun ? 'Dry run - add ?confirm=yes to execute' : `Created ${totalCreated} ledger entries`,
      summary: {
        totalOrders: ordersData.length,
        skippedOrders: totalSkipped,
        entriesCreated: totalCreated,
        results: results
      }
    });

  } catch (error: unknown) {
    log.error('[backfill-ledger] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
