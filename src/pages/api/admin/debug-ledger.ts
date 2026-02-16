// src/pages/api/admin/debug-ledger.ts
// Debug endpoint to check sales ledger entries and backfill missing ones

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`debug-ledger:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const runtimeEnv = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: runtimeEnv?.ADMIN_UIDS, ADMIN_EMAILS: runtimeEnv?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const saQuery = getSaQuery(locals);

  try {
    // Get all ledger entries using service account
    let ledgerData: any[] = [];
    let ledgerSource = 'service_account';
    try {
      ledgerData = await saQuery('salesLedger', { limit: 500 });
    } catch (err) {
      console.log('[debug-ledger] SA query failed:', err);
      ledgerSource = 'fallback';
      ledgerData = [];
    }

    // Also get orders to compare
    const ordersData = await saQuery('orders', { limit: 100, skipCache: true });

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
    return ApiErrors.serverError('Unknown error');
  }
};
