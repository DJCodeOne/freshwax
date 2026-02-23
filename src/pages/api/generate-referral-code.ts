// src/pages/api/generate-referral-code.ts
// Generate a referral code for Plus members - uses KV storage (not Firebase)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, verifyUserToken } from '../../lib/firebase-rest';
import { createReferralCode, saveReferralCode, getUserReferralCode, getReferralCode } from '../../lib/referral-codes';
import { createLogger, errorResponse, successResponse, ApiErrors } from '../../lib/api-utils';

const log = createLogger('generate-referral-code');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const GenerateReferralSchema = z.object({
  userId: z.string().min(1, 'Missing userId').max(200),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`generate-referral:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    if (!kv) {
      log.error('KV namespace not available');
      return errorResponse('Storage not available', 503);
    }

    // Get auth token
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;

    const rawBody = await request.json();
    const parsed = GenerateReferralSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId } = parsed.data;

    // Require auth token
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Verify the token matches the userId
    try {
      const tokenUserId = await verifyUserToken(idToken);
      if (tokenUserId !== userId) {
        return ApiErrors.forbidden('User mismatch');
      }
    } catch (e: unknown) {
      log.error('Token verification failed:', e);
      return ApiErrors.unauthorized('Invalid authentication token');
    }

    // Check if user already has a referral code in KV
    const existingCode = await getUserReferralCode(kv, userId);
    if (existingCode) {
      // Return existing code
      const existingData = await getReferralCode(kv, existingCode);
      return successResponse({ code: existingCode,
        message: 'You already have a referral code',
        data: existingData });
    }

    // Get user document to verify Plus status (read-only, doesn't count much against quota)
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return ApiErrors.notFound('User not found');
    }

    // Check if user is Plus member
    let isPro = false;
    if (userDoc.subscription?.tier === 'pro') {
      const expiresAt = userDoc.subscription.expiresAt;
      if (expiresAt) {
        const expiryDate = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
        isPro = expiryDate > new Date();
      }
    }

    if (!isPro) {
      return ApiErrors.forbidden('Only Plus members can generate referral codes');
    }

    // Generate referral code
    log.info('Generating code for user:', userId);
    const referralCode = createReferralCode(
      userId,
      userDoc.displayName || 'Plus Member',
      50,  // 50% discount
      'pro_upgrade'  // Only valid for Plus upgrades
    );

    // Save to KV
    await saveReferralCode(kv, referralCode);
    log.info('Saved to KV:', referralCode.code);

    return successResponse({ code: referralCode.code,
      message: 'Referral code generated! Share it with a friend for 50% off Plus.',
      data: {
        discountPercent: referralCode.discountPercent,
        expiresAt: referralCode.expiresAt,
        maxUses: referralCode.maxUses
      } });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to generate code');
  }
};
