// src/pages/api/admin/update-ledger-entry.ts
// Admin endpoint to correct ledger entries
// Dual-write: D1 (primary) + Firebase (backup)

import type { APIRoute } from 'astro';
import { saUpdateDocument, saQueryCollection, saDeleteDocument } from '../../../lib/firebase-service-account';
import { d1GetLedgerEntries, d1UpdateLedgerEntry, d1DeleteLedgerEntry } from '../../../lib/d1-catalog';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
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

    const body = await request.json();
    const { action, ledgerId, updates } = body;

    const db = env?.DB;

    if (action === 'list') {
      // List all ledger entries - try D1 first
      let entries: any[] = [];

      if (db) {
        try {
          entries = await d1GetLedgerEntries(db, { limit: 100 });
          console.log('[update-ledger] D1 read:', entries.length, 'entries');
        } catch (d1Error) {
          console.error('[update-ledger] D1 read failed:', d1Error);
        }
      }

      // Fallback to Firebase if D1 empty or failed
      if (entries.length === 0) {
        entries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
          orderBy: { field: 'timestamp', direction: 'DESCENDING' },
          limit: 100
        });
      }

      return new Response(JSON.stringify({ success: true, entries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'update' && ledgerId && updates) {
      // Recalculate derived fields
      if (updates.grossTotal !== undefined || updates.stripeFee !== undefined ||
          updates.paypalFee !== undefined || updates.freshWaxFee !== undefined) {
        const totalFees = (updates.stripeFee || 0) + (updates.paypalFee || 0) + (updates.freshWaxFee || 0);
        updates.totalFees = totalFees;
        updates.netRevenue = (updates.grossTotal || 0) - totalFees;
      }

      // Update Firebase first
      await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', ledgerId, {
        ...updates,
        correctedAt: new Date().toISOString()
      });

      // Also update D1
      if (db) {
        try {
          await d1UpdateLedgerEntry(db, ledgerId, updates);
          console.log('[update-ledger] D1 updated:', ledgerId);
        } catch (d1Error) {
          console.error('[update-ledger] D1 update failed:', d1Error);
          // Don't fail - Firebase update succeeded
        }
      }

      return new Response(JSON.stringify({ success: true, message: 'Entry updated (D1 + Firebase)' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'delete' && ledgerId) {
      // Delete from Firebase first
      await saDeleteDocument(serviceAccountKey, projectId, 'salesLedger', ledgerId);

      // Also delete from D1
      if (db) {
        try {
          await d1DeleteLedgerEntry(db, ledgerId);
          console.log('[update-ledger] D1 deleted:', ledgerId);
        } catch (d1Error) {
          console.error('[update-ledger] D1 delete failed:', d1Error);
          // Don't fail - Firebase delete succeeded
        }
      }

      return new Response(JSON.stringify({ success: true, message: 'Entry deleted (D1 + Firebase)' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action',
      usage: {
        list: { action: 'list' },
        update: { action: 'update', ledgerId: 'xxx', updates: { grossTotal: 2.00, paypalFee: 0.23 } },
        delete: { action: 'delete', ledgerId: 'xxx' }
      }
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
