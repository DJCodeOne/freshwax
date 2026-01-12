// src/pages/api/admin/migrate-orders-to-ledger.ts
// One-time migration script to backfill existing orders to the sales ledger
// Run via: GET /api/admin/migrate-orders-to-ledger?confirm=yes

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saSetDocument, saQueryCollection } from '../../../lib/firebase-service-account';
import { initAdminEnv } from '../../../lib/admin';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm');
  const dryRun = url.searchParams.get('dryRun') === 'yes';

  // Initialize environment
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS || '',
  });

  // Require confirmation
  if (confirm !== 'yes') {
    return new Response(JSON.stringify({
      message: 'Migration script for orders to sales ledger',
      warning: 'This will create ledger entries for all existing orders',
      usage: 'Add ?confirm=yes to run the migration',
      dryRunUsage: 'Add ?confirm=yes&dryRun=yes to preview without writing'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    console.log('[Migration] Starting orders to ledger migration...');
    console.log('[Migration] Dry run:', dryRun);

    // Get service account for Firebase writes
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Firebase service account not configured',
        hint: 'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build service account key JSON from individual parts
    const serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'auto',
      private_key: privateKey.replace(/\\n/g, '\n'),
      client_email: clientEmail,
      client_id: '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    });

    // Fetch all orders using service account
    let orders: any[] = [];
    try {
      orders = await saQueryCollection(serviceAccountKey, projectId, 'orders', {
        orderBy: { field: 'createdAt', direction: 'ASCENDING' },
        limit: 5000
      });
    } catch (orderErr) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch orders: ' + (orderErr instanceof Error ? orderErr.message : 'Unknown error'),
        hint: 'Check that the service account has Firestore access'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[Migration] Found ${orders.length} orders`);

    // Check existing ledger entries to avoid duplicates
    let existingLedger: any[] = [];
    try {
      existingLedger = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
        limit: 5000
      });
    } catch (e) {
      // Collection might not exist yet
      console.log('[Migration] No existing ledger entries found');
    }
    const existingOrderIds = new Set(existingLedger.map((e: any) => e.orderId));
    console.log(`[Migration] Found ${existingLedger.length} existing ledger entries`);

    const results = {
      total: orders.length,
      skipped: 0,
      migrated: 0,
      errors: 0,
      cancelled: 0,
      testOrders: 0,
      details: [] as any[]
    };

    for (const order of orders) {
      try {
        // Skip if already in ledger
        if (existingOrderIds.has(order.id)) {
          results.skipped++;
          continue;
        }

        // Skip cancelled orders
        if (order.status === 'cancelled') {
          results.cancelled++;
          continue;
        }

        // Skip test orders
        if (order.paymentMethod === 'test_mode') {
          results.testOrders++;
          continue;
        }

        // Parse created date
        const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();

        // Calculate totals from order data
        const subtotal = order.totals?.subtotal || order.subtotal || 0;
        const shipping = order.totals?.shipping || order.shipping || 0;
        const grossTotal = order.totals?.total || order.total || order.orderTotal || order.grandTotal || order.amount || 0;

        // Calculate fees
        const freshWaxFee = order.totals?.freshWaxFee || 0;
        const serviceFees = order.totals?.serviceFees || 0;
        let stripeFee = order.totals?.stripeFee || order.totals?.paymentProcessingFee || 0;
        let paypalFee = 0;

        // Determine payment method and estimate fees if not recorded
        const isPayPal = order.paymentMethod === 'paypal' || order.paymentMethod === 'paypal_manual';
        const isStripe = order.paymentMethod === 'stripe';
        const isFree = order.paymentMethod === 'free' || order.paymentMethod === 'credit' || grossTotal === 0;

        if (!stripeFee && !paypalFee && serviceFees && freshWaxFee) {
          // Calculate processing fee from serviceFees
          const processingFee = serviceFees - freshWaxFee;
          if (isPayPal) {
            paypalFee = processingFee;
          } else {
            stripeFee = processingFee;
          }
        } else if (!stripeFee && !paypalFee && grossTotal > 0 && !isFree) {
          // Estimate fees based on payment method
          if (isPayPal) {
            paypalFee = Math.round((grossTotal * 0.029 + 0.30) * 100) / 100;
          } else if (isStripe) {
            stripeFee = Math.round((grossTotal * 0.015 + 0.20) * 100) / 100;
          }
        }

        const totalFees = stripeFee + paypalFee + freshWaxFee;
        const netRevenue = grossTotal - totalFees;

        // Process items
        const items = (order.items || []).map((item: any) => {
          const type = item.type === 'merch' || item.isPhysical ? 'merch' :
                       item.type === 'vinyl' ? 'vinyl' :
                       item.type === 'track' ? 'track' :
                       item.type === 'release' || item.type === 'digital' || item.releaseId ? 'release' : 'other';

          return {
            type,
            id: item.releaseId || item.productId || item.id || '',
            title: item.title || item.name || 'Unknown',
            artist: item.artist || item.artistName || undefined,
            quantity: item.quantity || 1,
            unitPrice: item.price || 0,
            lineTotal: (item.price || 0) * (item.quantity || 1)
          };
        });

        // Build ledger entry
        const ledgerEntry = {
          orderId: order.id,
          orderNumber: order.orderNumber || '',
          timestamp: createdAt.toISOString(),
          year: createdAt.getFullYear(),
          month: createdAt.getMonth() + 1,
          day: createdAt.getDate(),
          customerId: order.customer?.userId || order.customerId || null,
          customerEmail: order.customer?.email || order.customerEmail || '',
          subtotal,
          shipping,
          discount: order.totals?.discount || 0,
          grossTotal,
          stripeFee,
          paypalFee,
          freshWaxFee,
          totalFees,
          netRevenue,
          paymentMethod: isFree ? 'free' : (isPayPal ? 'paypal' : 'stripe'),
          paymentId: order.paymentIntentId || order.paypalOrderId || null,
          currency: 'GBP',
          itemCount: items.length,
          hasPhysical: order.hasPhysicalItems || items.some((i: any) => i.type === 'merch' || i.type === 'vinyl'),
          hasDigital: items.some((i: any) => i.type === 'release' || i.type === 'track'),
          items,
          // Mark as migrated
          migratedAt: new Date().toISOString(),
          migratedFrom: 'orders'
        };

        if (dryRun) {
          results.details.push({
            orderNumber: order.orderNumber,
            grossTotal,
            paymentMethod: ledgerEntry.paymentMethod,
            wouldCreate: true
          });
        } else {
          // Write to ledger using service account
          const ledgerId = `ledger_${order.id}`;
          await saSetDocument(serviceAccountKey, projectId, 'salesLedger', ledgerId, ledgerEntry);
        }

        results.migrated++;

      } catch (orderErr) {
        console.error(`[Migration] Error processing order ${order.id}:`, orderErr);
        results.errors++;
        results.details.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          error: orderErr instanceof Error ? orderErr.message : 'Unknown error'
        });
      }
    }

    console.log('[Migration] Complete:', results);

    return new Response(JSON.stringify({
      success: true,
      dryRun,
      results,
      message: dryRun
        ? `Dry run complete. Would migrate ${results.migrated} orders.`
        : `Migration complete. Migrated ${results.migrated} orders to ledger.`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Migration] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Migration failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
