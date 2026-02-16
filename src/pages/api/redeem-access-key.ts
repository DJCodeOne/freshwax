// src/pages/api/redeem-access-key.ts
// API for users to redeem a quick access key and gain DJ lobby access

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, updateDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const RedeemAccessKeySchema = z.object({
  code: z.string().min(1, 'Access code is required').max(100),
  userId: z.string().min(1, 'User ID is required').max(200),
  userEmail: z.string().email().max(320).optional().nullable(),
  userName: z.string().max(200).optional().nullable(),
});

// Helper to initialize Firebase
function initFirebase(locals: App.Locals) {
  const env = locals?.runtime?.env;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: strict - 5 per minute (prevent brute force of access codes)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`redeem-access-key:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  initFirebase(locals);

  try {
    const data = await request.json();
    const parsed = RedeemAccessKeySchema.safeParse(data);
    if (!parsed.success) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request',
        details: parsed.error.issues.map(i => i.message)
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const { code, userId, userEmail, userName } = parsed.data;

    // SECURITY: Verify authentication matches userId
    const { userId: authUserId, error: authError } = await verifyRequestUser(request);
    if (!authUserId || authError) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (authUserId !== userId) {
      return new Response(JSON.stringify({ success: false, error: 'User ID does not match authentication' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
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
    } catch (updateError: unknown) {
      try {
        await setDocument('users', userId, userUpdateData);
      } catch (createError: unknown) {
        // Log but don't fail - djLobbyBypass entry was created successfully
        console.warn(`[redeem-access-key] Could not set user bypass flag: ${createError instanceof Error ? createError.message : String(createError)}`);
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

  } catch (error: unknown) {
    console.error('[redeem-access-key] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
