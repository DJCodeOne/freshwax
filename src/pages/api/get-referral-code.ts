// src/pages/api/get-referral-code.ts
// Get user's referral code from KV storage
import type { APIRoute } from 'astro';
import { verifyUserToken } from '../../lib/firebase-rest';
import { getUserReferralCode, getReferralCode } from '../../lib/referral-codes';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    if (!kv) {
      return new Response(JSON.stringify({ success: false, error: 'Storage not available' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'Missing userId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SECURITY: Require authentication and verify userId matches
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || '';

    if (!idToken) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user's code from KV
    const code = await getUserReferralCode(kv, userId);

    if (!code) {
      return new Response(JSON.stringify({
        success: true,
        hasCode: false,
        code: null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get full code data
    const codeData = await getReferralCode(kv, code);

    return new Response(JSON.stringify({
      success: true,
      hasCode: true,
      code: code,
      data: codeData ? {
        discountPercent: codeData.discountPercent,
        expiresAt: codeData.expiresAt,
        usedCount: codeData.usedCount,
        maxUses: codeData.maxUses,
        active: codeData.active
      } : null
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[get-referral-code] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get code'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
