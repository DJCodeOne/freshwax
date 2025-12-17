// src/pages/api/admin/quick-access-key.ts
// Admin API for managing the quick access key
// Allows admin to generate a key that gives DJs instant lobby access when redeemed

import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

const ADMIN_KEY = 'freshwax-admin-2024';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
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
  initFirebase(locals);

  const url = new URL(request.url);
  const adminKey = url.searchParams.get('adminKey');

  // Admin key check
  if (adminKey !== ADMIN_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

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
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Generate, revoke, or update quick access key
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const data = await request.json();
    const { action, adminKey, expiresAt } = data;

    // Admin key check
    if (adminKey !== ADMIN_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

      await setDocument('system', 'quickAccessKey', newKeyData);

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

      await setDocument('system', 'quickAccessKey', {
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

      await setDocument('system', 'quickAccessKey', {
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
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
