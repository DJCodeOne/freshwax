// src/pages/api/admin/update-ledger-entry.ts
// Admin endpoint to correct ledger entries
// Dual-write: D1 (primary) + Firebase (backup)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { saUpdateDocument, saQueryCollection, saDeleteDocument } from '../../../lib/firebase-service-account';
import { d1GetLedgerEntries, d1UpdateLedgerEntry, d1DeleteLedgerEntry } from '../../../lib/d1-catalog';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';
const log = createLogger('[update-ledger-entry]');

const updateLedgerEntrySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), adminKey: z.string().optional() }),
  z.object({ action: z.literal('update'), ledgerId: z.string().min(1), updates: z.record(z.any()), adminKey: z.string().optional() }),
  z.object({ action: z.literal('delete'), ledgerId: z.string().min(1), adminKey: z.string().optional() }),
]);

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-ledger-entry:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
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

    const body = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = updateLedgerEntrySchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action } = parsed.data;
    const ledgerId = 'ledgerId' in parsed.data ? parsed.data.ledgerId : undefined;
    const updates = 'updates' in parsed.data ? parsed.data.updates : undefined;

    const db = env?.DB;

    if (action === 'list') {
      // List all ledger entries - try D1 first
      let entries: Record<string, unknown>[] = [];

      if (db) {
        try {
          entries = await d1GetLedgerEntries(db, { limit: 100 });
          log.info('[update-ledger] D1 read:', entries.length, 'entries');
        } catch (d1Error: unknown) {
          log.error('[update-ledger] D1 read failed:', d1Error);
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
          log.info('[update-ledger] D1 updated:', ledgerId);
        } catch (d1Error: unknown) {
          log.error('[update-ledger] D1 update failed:', d1Error);
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
          log.info('[update-ledger] D1 deleted:', ledgerId);
        } catch (d1Error: unknown) {
          log.error('[update-ledger] D1 delete failed:', d1Error);
          // Don't fail - Firebase delete succeeded
        }
      }

      return new Response(JSON.stringify({ success: true, message: 'Entry deleted (D1 + Firebase)' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
