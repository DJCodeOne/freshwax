// src/pages/api/get-referral-code.ts
// Get user's referral code from KV storage
import type { APIRoute } from 'astro';
import { verifyUserToken } from '../../lib/firebase-rest';
import { getUserReferralCode, getReferralCode } from '../../lib/referral-codes';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { errorResponse, ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('get-referral-code');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-referral-code:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    if (!kv) {
      return errorResponse('Storage not available', 503);
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return ApiErrors.badRequest('Missing userId');
    }

    // SECURITY: Require authentication and verify userId matches
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || '';

    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('Not authorized');
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

  } catch (error: unknown) {
    log.error('[get-referral-code] Error:', error);
    return ApiErrors.serverError('Failed to get code');
  }
};
