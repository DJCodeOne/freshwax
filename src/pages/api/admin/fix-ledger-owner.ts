// src/pages/api/admin/fix-ledger-owner.ts
// Fix ledger entry submitterId to correct owner

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const oldOwnerId = url.searchParams.get('oldOwnerId');
  const newOwnerId = url.searchParams.get('newOwnerId');
  const confirm = url.searchParams.get('confirm');

  if (!newOwnerId) {
    return new Response(JSON.stringify({
      error: 'Missing newOwnerId',
      usage: '/api/admin/fix-ledger-owner?orderNumber=xxx&newOwnerId=yyy&confirm=yes',
      altUsage: '/api/admin/fix-ledger-owner?oldOwnerId=xxx&newOwnerId=yyy&confirm=yes (updates all matching)'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

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
    // Get all ledger entries
    const allEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      limit: 500
    });

    // Filter entries to update
    let entriesToUpdate: any[] = [];

    if (orderNumber) {
      // Update specific order
      entriesToUpdate = allEntries.filter((e: any) => e.orderNumber === orderNumber);
    } else if (oldOwnerId) {
      // Update all entries with oldOwnerId
      entriesToUpdate = allEntries.filter((e: any) =>
        e.submitterId === oldOwnerId || e.artistId === oldOwnerId
      );
    }

    if (entriesToUpdate.length === 0) {
      return new Response(JSON.stringify({
        error: 'No matching ledger entries found',
        orderNumber,
        oldOwnerId
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (confirm !== 'yes') {
      return new Response(JSON.stringify({
        message: `Would update ${entriesToUpdate.length} ledger entries`,
        entries: entriesToUpdate.map((e: any) => ({
          id: e.id,
          orderNumber: e.orderNumber,
          currentSubmitterId: e.submitterId,
          currentArtistId: e.artistId,
          wouldSetTo: newOwnerId
        })),
        usage: 'Add &confirm=yes to apply'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Apply updates
    const results: any[] = [];
    for (const entry of entriesToUpdate) {
      await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', entry.id, {
        submitterId: newOwnerId,
        artistId: newOwnerId
      });
      results.push({ id: entry.id, orderNumber: entry.orderNumber, updated: true });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${results.length} ledger entries`,
      results
    }), {
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
