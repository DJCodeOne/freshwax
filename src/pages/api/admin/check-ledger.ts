// src/pages/api/admin/check-ledger.ts
// Check sales ledger for a user

import type { APIRoute } from 'astro';

import { saQueryCollection } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-ledger:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return ApiErrors.serverError('Service account not configured');
  }

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

  try {
    const ledger = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      limit: 100
    });

    let userEntries = ledger;
    if (userId) {
      userEntries = ledger.filter((e: any) =>
        e.submitterId === userId ||
        e.artistId === userId ||
        e.artistName === userId
      );
    }

    const summary = userEntries.map((e: any) => ({
      orderId: e.orderId,
      orderNumber: e.orderNumber,
      timestamp: e.timestamp,
      grossTotal: e.grossTotal,
      netRevenue: e.netRevenue,
      artistPayout: e.artistPayout,
      artistPayoutStatus: e.artistPayoutStatus,
      submitterId: e.submitterId || 'NOT SET',
      artistId: e.artistId || 'NOT SET',
      artistName: e.artistName || 'NOT SET',
      items: (e.items || []).map((i: any) => ({ id: i.id, releaseId: i.releaseId, productId: i.productId, title: i.title, type: i.type }))
    }));

    const totals = {
      entries: userEntries.length,
      totalGross: userEntries.reduce((sum: number, e: any) => sum + (e.grossTotal || 0), 0),
      totalNet: userEntries.reduce((sum: number, e: any) => sum + (e.netRevenue || 0), 0),
      totalPayout: userEntries.reduce((sum: number, e: any) => sum + (e.artistPayout || 0), 0),
      pendingPayout: userEntries.filter((e: any) => e.artistPayoutStatus === 'pending')
        .reduce((sum: number, e: any) => sum + (e.artistPayout || 0), 0)
    };

    return new Response(JSON.stringify({
      userId,
      totals,
      entries: summary
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
