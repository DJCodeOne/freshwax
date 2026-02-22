// src/pages/api/admin/fix-ledger-owner.ts
// Fix ledger entry submitterId to correct owner

import type { APIRoute } from 'astro';

import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, successResponse, jsonResponse } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`fix-ledger-owner:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const orderNumber = url.searchParams.get('orderNumber');
  const oldOwnerId = url.searchParams.get('oldOwnerId');
  const newOwnerId = url.searchParams.get('newOwnerId');
  const confirm = url.searchParams.get('confirm');

  if (!newOwnerId) {
    return ApiErrors.badRequest('Missing newOwnerId');
  }

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
    // Get all ledger entries
    const allEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
      limit: 500
    });

    // Filter entries to update
    let entriesToUpdate: Record<string, unknown>[] = [];

    if (orderNumber) {
      // Update specific order
      entriesToUpdate = allEntries.filter((e: Record<string, unknown>) => e.orderNumber === orderNumber);
    } else if (oldOwnerId) {
      // Update all entries with oldOwnerId
      entriesToUpdate = allEntries.filter((e: Record<string, unknown>) =>
        e.submitterId === oldOwnerId || e.artistId === oldOwnerId
      );
    }

    if (entriesToUpdate.length === 0) {
      return ApiErrors.notFound('No matching ledger entries found');
    }

    if (confirm !== 'yes') {
      return jsonResponse({
        message: `Would update ${entriesToUpdate.length} ledger entries`,
        entries: entriesToUpdate.map((e: Record<string, unknown>) => ({
          id: e.id,
          orderNumber: e.orderNumber,
          currentSubmitterId: e.submitterId,
          currentArtistId: e.artistId,
          wouldSetTo: newOwnerId
        })),
        usage: 'Add &confirm=yes to apply'
      });
    }

    // Apply updates
    const results: Record<string, unknown>[] = [];
    for (const entry of entriesToUpdate) {
      await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', entry.id, {
        submitterId: newOwnerId,
        artistId: newOwnerId
      });
      results.push({ id: entry.id, orderNumber: entry.orderNumber, updated: true });
    }

    return successResponse({ message: `Updated ${results.length} ledger entries`,
      results });
  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
