// src/pages/api/admin/quick-access-key.ts
// Admin API for managing the quick access key
// Allows admin to generate a key that gives DJs instant lobby access when redeemed

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument } from '../../../lib/firebase-rest';
import { saSetDocument } from '../../../lib/firebase-service-account';
import { getAdminFirebaseContext } from '../../../lib/firebase/admin-context';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const QuickAccessKeySchema = z.object({
  action: z.enum(['generate', 'revoke', 'setExpiry']),
  expiresAt: z.string().optional(),
  adminKey: z.string().optional(),
}).strip();

const log = createLogger('[quick-access-key]');

export const prerender = false;

// Generate a random 8-character code
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars like 0, O, 1, I
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// GET: Get current quick access key (admin only)
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`quick-access-key:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const keyDoc = await getDocument('system', 'quickAccessKey');

    if (!keyDoc) {
      return successResponse({ hasKey: false,
        key: null });
    }

    return successResponse({ hasKey: true,
      key: {
        code: keyDoc.code,
        active: keyDoc.active,
        createdAt: keyDoc.createdAt,
        createdBy: keyDoc.createdBy,
        expiresAt: keyDoc.expiresAt || null,
        usedBy: keyDoc.usedBy || [],
        usedCount: (keyDoc.usedBy || []).length
      } });
  } catch (error: unknown) {
    log.error('[quick-access-key] Error getting key:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// POST: Generate, revoke, or update quick access key
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`quick-access-key-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  const fbCtx = getAdminFirebaseContext(locals);
  if (fbCtx instanceof Response) return fbCtx;
  const { env, projectId, saKey: serviceAccountKey } = fbCtx;

  try {
    const rawBody = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const postAuthError = await requireAdminAuth(request, locals, rawBody);
    if (postAuthError) return postAuthError;

    const parseResult = QuickAccessKeySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { action, expiresAt } = parseResult.data;

    if (action === 'generate') {
      // Generate a new quick access key
      const newCode = generateCode();
      const now = new Date().toISOString();

      // Get existing key to preserve usedBy history (optional)
      const existingKey = await getDocument('system', 'quickAccessKey');

      const newKeyData = {
        code: newCode,
        active: true,
        createdAt: now,
        createdBy: 'admin',
        expiresAt: expiresAt || null,
        usedBy: [] // Reset usedBy for new key
      };

      await saSetDocument(serviceAccountKey, projectId, 'system', 'quickAccessKey', newKeyData);

      log.info(`[quick-access-key] Generated new key: ${newCode}`);

      return successResponse({ message: 'Quick access key generated',
        key: newKeyData });

    } else if (action === 'revoke') {
      // Revoke the current key (prevents new redemptions, keeps existing user access)
      const existingKey = await getDocument('system', 'quickAccessKey');

      if (!existingKey) {
        return ApiErrors.notFound('No key exists');
      }

      await saSetDocument(serviceAccountKey, projectId, 'system', 'quickAccessKey', {
        ...existingKey,
        active: false,
        revokedAt: new Date().toISOString()
      });

      log.info('[quick-access-key] Key revoked');

      return successResponse({ message: 'Quick access key revoked. Users who already redeemed keep their access.' });

    } else if (action === 'setExpiry') {
      // Update expiry date on existing key
      const existingKey = await getDocument('system', 'quickAccessKey');

      if (!existingKey) {
        return ApiErrors.notFound('No key exists');
      }

      await saSetDocument(serviceAccountKey, projectId, 'system', 'quickAccessKey', {
        ...existingKey,
        expiresAt: expiresAt || null
      });

      log.info(`[quick-access-key] Expiry updated to: ${expiresAt || 'none'}`);

      return successResponse({ message: expiresAt ? `Expiry set to ${expiresAt}` : 'Expiry removed' });

    } else {
      return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    log.error('[quick-access-key] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
