// src/pages/api/admin/sync-ledger-to-d1.ts
// One-time migration: Sync existing Firebase ledger entries to D1

import type { APIRoute } from 'astro';
import { saQueryCollection } from '../../../lib/firebase-service-account';
import { d1InsertLedgerEntry, d1GetLedgerEntryById } from '../../../lib/d1-catalog';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;
    const db = env?.DB;

    if (!clientEmail || !privateKey) {
      return new Response(JSON.stringify({ error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!db) {
      return new Response(JSON.stringify({ error: 'D1 database not configured' }), {
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

    // Fetch all Firebase ledger entries
    console.log('[sync-ledger] Fetching Firebase entries...');
    const firebaseEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      orderBy: { field: 'timestamp', direction: 'DESCENDING' },
      limit: 2000
    });
    console.log('[sync-ledger] Found', firebaseEntries.length, 'Firebase entries');

    let synced = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (const entry of firebaseEntries) {
      try {
        // Check if already exists in D1
        const existing = await d1GetLedgerEntryById(db, entry.id);
        if (existing) {
          skipped++;
          continue;
        }

        // Insert into D1
        await d1InsertLedgerEntry(db, entry.id, entry);
        synced++;
      } catch (err) {
        errors++;
        errorDetails.push(`${entry.id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Sync complete`,
      stats: {
        total: firebaseEntries.length,
        synced,
        skipped,
        errors
      },
      errorDetails: errorDetails.slice(0, 10) // First 10 errors
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[sync-ledger] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
