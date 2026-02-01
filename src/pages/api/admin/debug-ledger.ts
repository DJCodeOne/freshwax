// src/pages/api/admin/debug-ledger.ts
// Debug endpoint to check sales ledger entries and backfill missing ones

import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase env
  const runtimeEnv = (locals as any)?.runtime?.env;
  initFirebaseEnv(runtimeEnv);

  // Get service account credentials
  const projectId = runtimeEnv?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = runtimeEnv?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = runtimeEnv?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  let serviceAccountKey = '';
  if (clientEmail && privateKey) {
    serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey.replace(/\\n/g, '\n'),
      client_email: clientEmail
    });
  }

  try {
    // Get all ledger entries using service account if available
    let ledgerData: any[] = [];
    let ledgerSource = 'none';

    if (serviceAccountKey) {
      try {
        ledgerData = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', { limit: 500 });
        ledgerSource = 'service_account';
      } catch (saErr) {
        console.log('[debug-ledger] SA query failed:', saErr);
        ledgerData = await queryCollection('salesLedger', { limit: 500, skipCache: true });
        ledgerSource = 'public_api';
      }
    } else {
      ledgerData = await queryCollection('salesLedger', { limit: 500, skipCache: true });
      ledgerSource = 'public_api';
    }

    // Also get orders to compare
    const ordersData = await queryCollection('orders', { limit: 100, skipCache: true });

    // Check releases status
    const releasesData = await queryCollection('releases', { limit: 500, skipCache: true });
    const releasesByStatus: Record<string, number> = {};
    for (const r of releasesData) {
      const status = r.status || 'unknown';
      releasesByStatus[status] = (releasesByStatus[status] || 0) + 1;
    }

    // Analyze entries
    const analysis = ledgerData.map(entry => ({
      id: entry.id,
      orderId: entry.orderId,
      artistId: entry.artistId,
      artistName: entry.artistName,
      artistPayout: entry.artistPayout,
      artistPayoutStatus: entry.artistPayoutStatus,
      grossTotal: entry.grossTotal,
      createdAt: entry.createdAt,
      // Show all fields to find the issue
      allFields: Object.keys(entry)
    }));

    // Find pending entries
    const pendingEntries = ledgerData.filter(e =>
      e.artistPayoutStatus === 'pending' || e.artistPayoutStatus === 'unpaid'
    );

    // Calculate totals
    const totalPending = pendingEntries.reduce((sum, e) => sum + (e.artistPayout || 0), 0);

    // Analyze orders
    const orderSummary = ordersData.map(o => ({
      id: o.id,
      status: o.status || o.orderStatus,
      paymentStatus: o.paymentStatus,
      total: o.totals?.total || o.total,
      artistEarnings: o.totals?.artistEarnings,
      items: (o.items || []).map((i: any) => ({
        title: i.title || i.name,
        artistId: i.artistId,
        artistName: i.artistName
      })),
      createdAt: o.createdAt
    }));

    return new Response(JSON.stringify({
      success: true,
      ledger: {
        source: ledgerSource,
        totalEntries: ledgerData.length,
        pendingCount: pendingEntries.length,
        totalPendingAmount: totalPending,
        entries: analysis
      },
      orders: {
        totalOrders: ordersData.length,
        orders: orderSummary
      },
      releases: {
        total: releasesData.length,
        byStatus: releasesByStatus
      }
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[debug-ledger] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
