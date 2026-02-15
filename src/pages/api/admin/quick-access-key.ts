// src/pages/api/admin/quick-access-key.ts
// Admin API for managing the quick access key
// Allows admin to generate a key that gives DJs instant lobby access when redeemed

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { saSetDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
}

// Build service account key from individual env vars
function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

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
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  initFirebase(locals);
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const keyDoc = await getDocument('system', 'quickAccessKey');

    if (!keyDoc) {
      return new Response(JSON.stringify({
        success: true,
        hasKey: false,
        key: null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      hasKey: true,
      key: {
        code: keyDoc.code,
        active: keyDoc.active,
        createdAt: keyDoc.createdAt,
        createdBy: keyDoc.createdBy,
        expiresAt: keyDoc.expiresAt || null,
        usedBy: keyDoc.usedBy || [],
        usedCount: (keyDoc.usedBy || []).length
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[quick-access-key] Error getting key:', error);
    return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Generate, revoke, or update quick access key
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`quick-access-key-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  initFirebase(locals);
  const env = (locals as any)?.runtime?.env;
  const serviceAccountKey = getServiceAccountKey(env);
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  if (!serviceAccountKey) {
    return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const data = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const postAuthError = await requireAdminAuth(request, locals, data);
    if (postAuthError) return postAuthError;

    const { action, expiresAt } = data;

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

      console.log(`[quick-access-key] Generated new key: ${newCode}`);

      return new Response(JSON.stringify({
        success: true,
        message: 'Quick access key generated',
        key: newKeyData
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'revoke') {
      // Revoke the current key (prevents new redemptions, keeps existing user access)
      const existingKey = await getDocument('system', 'quickAccessKey');

      if (!existingKey) {
        return new Response(JSON.stringify({ success: false, error: 'No key exists' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await saSetDocument(serviceAccountKey, projectId, 'system', 'quickAccessKey', {
        ...existingKey,
        active: false,
        revokedAt: new Date().toISOString()
      });

      console.log('[quick-access-key] Key revoked');

      return new Response(JSON.stringify({
        success: true,
        message: 'Quick access key revoked. Users who already redeemed keep their access.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'setExpiry') {
      // Update expiry date on existing key
      const existingKey = await getDocument('system', 'quickAccessKey');

      if (!existingKey) {
        return new Response(JSON.stringify({ success: false, error: 'No key exists' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await saSetDocument(serviceAccountKey, projectId, 'system', 'quickAccessKey', {
        ...existingKey,
        expiresAt: expiresAt || null
      });

      console.log(`[quick-access-key] Expiry updated to: ${expiresAt || 'none'}`);

      return new Response(JSON.stringify({
        success: true,
        message: expiresAt ? `Expiry set to ${expiresAt}` : 'Expiry removed'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else {
      return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error: any) {
    console.error('[quick-access-key] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
