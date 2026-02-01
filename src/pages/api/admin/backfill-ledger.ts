// src/pages/api/admin/backfill-ledger.ts
// Backfill sales ledger entries for orders missing them
// Run via: GET /api/admin/backfill-ledger?confirm=yes

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saSetDocument, saQueryCollection, saGetDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm');
  const dryRun = confirm !== 'yes';

  // Initialize Firebase env
  const runtimeEnv = (locals as any)?.runtime?.env;
  initFirebaseEnv(runtimeEnv);

  // Get service account credentials
  const projectId = runtimeEnv?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = runtimeEnv?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = runtimeEnv?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Firebase service account not configured'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail
  });

  try {
    // Get all orders and ledger entries using service account
    let ordersData: any[] = [];
    let ledgerData: any[] = [];

    try {
      ordersData = await saQueryCollection(serviceAccountKey, projectId, 'orders', { limit: 500 });
      console.log('[backfill] Got', ordersData.length, 'orders from SA query');
    } catch (ordersErr) {
      console.error('[backfill] Orders query failed:', ordersErr);
      return new Response(JSON.stringify({
        success: false,
        error: 'Orders query failed: ' + (ordersErr instanceof Error ? ordersErr.message : String(ordersErr))
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    try {
      ledgerData = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', { limit: 500 });
      console.log('[backfill] Got', ledgerData.length, 'ledger entries from SA query');
    } catch (ledgerErr) {
      console.log('[backfill] Ledger query failed (may not exist yet):', ledgerErr);
      // Ledger might not exist yet - continue with empty
      ledgerData = [];
    }

    // Find orders that already have ledger entries
    const ordersWithLedger = new Set(ledgerData.map((e: any) => e.orderId));

    const results: any[] = [];
    let totalCreated = 0;
    let totalSkipped = 0;

    // Process each order
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

      // Process each item and look up seller info
      for (const item of items) {
        let submitterId = item.artistId || item.submitterId || null;
        let submitterEmail = item.artistEmail || item.submitterEmail || null;
        let artistName = item.artist || item.artistName || null;

        // Try to look up release for digital items
        const releaseId = item.releaseId || item.productId || item.id;
        if (!submitterId && releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || !item.type)) {
          try {
            const release = await saGetDocument(serviceAccountKey, projectId, 'releases', releaseId);
            if (release) {
              submitterId = release.submitterId || release.uploadedBy || release.userId || null;
              submitterEmail = release.email || release.submitterEmail || null;
              // Use submittedBy name if available, otherwise look up artist
              artistName = release.submittedBy || release.artistName || release.artist || artistName;

              // Look up the artist/user document to get proper display name
              if (submitterId) {
                try {
                  const artist = await saGetDocument(serviceAccountKey, projectId, 'artists', submitterId);
                  if (artist?.name || artist?.displayName) {
                    artistName = artist.displayName || artist.name;
                  }
                } catch (e) {
                  // Ignore - use release name
                }
              }
            }
          } catch (e) {
            // Ignore lookup errors
          }
        }

        // Try to look up merch
        if (!submitterId && item.productId && item.type === 'merch') {
          try {
            const merch = await saGetDocument(serviceAccountKey, projectId, 'merch', item.productId);
            if (merch) {
              submitterId = merch.supplierId || merch.sellerId || merch.userId || null;
              submitterEmail = merch.email || merch.sellerEmail || null;
              artistName = merch.sellerName || merch.supplierName || artistName;
            }
          } catch (e) {
            // Ignore lookup errors
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
          } catch (writeErr) {
            results.push({
              orderId: order.id,
              item: item.title || item.name,
              status: 'error',
              error: writeErr instanceof Error ? writeErr.message : 'Unknown error'
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      dryRun,
      message: dryRun ? 'Dry run - add ?confirm=yes to execute' : `Created ${totalCreated} ledger entries`,
      summary: {
        totalOrders: ordersData.length,
        skippedOrders: totalSkipped,
        entriesCreated: totalCreated,
        results: results
      }
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[backfill-ledger] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
