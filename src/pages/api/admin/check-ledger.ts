// src/pages/api/admin/check-ledger.ts
// Check sales ledger for a user

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return new Response(JSON.stringify({ error: 'Service account not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
      items: (e.items || []).map((i: any) => i.title)
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
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
