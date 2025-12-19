// src/pages/api/redeem-access-key.ts
// API for users to redeem a quick access key and gain DJ lobby access

import type { APIRoute } from 'astro';
import { getDocument, setDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const data = await request.json();
    const { code, userId, userEmail, userName } = data;

    if (!code || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Access code and user ID are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the quick access key document
    const keyDoc = await getDocument('system', 'quickAccessKey');

    if (!keyDoc) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid access code'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate the code matches (case-insensitive)
    if (keyDoc.code.toUpperCase() !== code.toUpperCase()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid access code'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if key is active
    if (!keyDoc.active) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This access code has been revoked'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if key has expired
    if (keyDoc.expiresAt) {
      const expiryDate = new Date(keyDoc.expiresAt);
      if (expiryDate < new Date()) {
        return new Response(JSON.stringify({
          success: false,
          error: 'This access code has expired'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Check if user already redeemed this code
    const usedBy = keyDoc.usedBy || [];
    const alreadyRedeemed = usedBy.some((u: any) => u.userId === userId);

    if (alreadyRedeemed) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You have already redeemed this access code'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user already has bypass access (check djLobbyBypass which is publicly readable)
    const existingBypass = await getDocument('djLobbyBypass', userId);
    if (existingBypass) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You already have DJ lobby access'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();

    // Add to djLobbyBypass collection first (publicly writable)
    await setDocument('djLobbyBypass', userId, {
      email: userEmail || null,
      name: userName || null,
      reason: 'Quick access key redemption',
      grantedAt: now,
      grantedBy: 'quick-access-key',
      quickAccessCode: code.toUpperCase()
    });

    // Also set user's bypass flag - try update first, then create if doesn't exist
    const userUpdateData = {
      'go-liveBypassed': true,
      bypassedAt: now,
      bypassedBy: 'quick-access-key',
      quickAccessCode: code.toUpperCase()
    };

    try {
      await updateDocument('users', userId, userUpdateData);
    } catch (updateError: any) {
      try {
        await setDocument('users', userId, userUpdateData);
      } catch (createError: any) {
        // Log but don't fail - djLobbyBypass entry was created successfully
        console.warn(`[redeem-access-key] Could not set user bypass flag: ${createError.message}`);
      }
    }

    // Update the key document with this redemption (use updateDocument to only change usedBy field)
    const updatedUsedBy = [
      ...usedBy,
      {
        userId,
        email: userEmail || null,
        name: userName || null,
        redeemedAt: now
      }
    ];

    await updateDocument('system', 'quickAccessKey', {
      usedBy: updatedUsedBy
    });

    console.log(`[redeem-access-key] User ${userId} (${userEmail}) redeemed access key`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Access granted! You can now enter the DJ lobby and go live.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[redeem-access-key] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
