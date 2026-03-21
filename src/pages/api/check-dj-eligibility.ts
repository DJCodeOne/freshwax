// src/pages/api/check-dj-eligibility.ts
// Check if a DJ meets the requirements to go live:
// - Must have at least 1 DJ mix uploaded
// - At least one mix must have 10+ likes
// - OR have an admin-granted bypass
// - Also returns bypass request status
import type { APIRoute } from 'astro';
import { getDocument, queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
import { isAdmin } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

export const prerender = false;
const REQUIRED_LIKES = 10;

const log = createLogger('check-dj-eligibility');

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`check-dj-eligibility:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  
  if (!userId) {
    return ApiErrors.badRequest('Missing userId parameter');
  }

  // Require authentication — only allow checking own eligibility (or admin)
  const { userId: authenticatedUserId, error: authError } = await verifyRequestUser(request);
  if (!authenticatedUserId) {
    return ApiErrors.unauthorized('Authentication required');
  }

  if (authenticatedUserId !== userId && !(await isAdmin(authenticatedUserId))) {
    return ApiErrors.forbidden('You can only check your own eligibility');
  }

  log.info('[check-dj-eligibility] Checking eligibility for:', userId);
  
  try {
    // Parallelize the first 3 independent Firebase calls
    const [moderation, bypass, userData] = await Promise.all([
      getDocument('djModeration', userId),
      getDocument('djLobbyBypass', userId),
      getDocument('users', userId),
    ]);

    // Check if user is banned or on hold
    if (moderation) {
      if (moderation.status === 'banned') {
        log.info('[check-dj-eligibility] User is banned');
        return successResponse({ eligible: false,
          reason: 'banned',
          message: 'Your account has been suspended from streaming.',
          bannedReason: moderation.reason || null });
      }

      if (moderation.status === 'hold') {
        log.info('[check-dj-eligibility] User is on hold');
        return successResponse({ eligible: false,
          reason: 'on_hold',
          message: 'Your streaming access is temporarily on hold.',
          holdReason: moderation.reason || null });
      }
    }

    // Check if user has an admin-granted bypass (legacy collection)
    if (bypass) {
      log.info('[check-dj-eligibility] User has admin bypass (djLobbyBypass collection)');
      return successResponse({ eligible: true,
        bypassGranted: true,
        reason: bypass.reason || null,
        message: 'Access granted by admin' });
    }

    // Check if user has go-liveBypassed flag on their user document
    if (userData) {
      if (userData['go-liveBypassed'] === true) {
        log.info('[check-dj-eligibility] User has go-live bypass flag on user doc');
        return successResponse({ eligible: true,
          bypassGranted: true,
          message: 'Access granted by admin' });
      }
    }

    // Parallelize the remaining 2 Firebase calls
    const [bypassRequests, mixes] = await Promise.all([
      queryCollection('bypassRequests', {
        filters: [
          { field: 'userId', op: 'EQUAL', value: userId },
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        limit: 1
      }),
      queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }]
      }),
    ]);

    let bypassRequest = null;
    if (bypassRequests.length > 0) {
      const reqData = bypassRequests[0];
      bypassRequest = {
        status: reqData.status,
        requestedAt: reqData.requestedAt || reqData.createdAt,
        denialReason: reqData.denialReason || null
      };
    }
    log.info('[check-dj-eligibility] Found', mixes.length, 'mixes for user');
    
    // Check if they have any mixes
    if (mixes.length === 0) {
      return successResponse({ eligible: false,
        reason: 'no_mixes',
        message: 'You need to upload at least one DJ mix to Fresh Wax before you can go live.',
        mixCount: 0,
        qualifyingMixes: 0,
        requiredLikes: REQUIRED_LIKES,
        bypassRequest });
    }
    
    // Check if any mix has 10+ likes
    const qualifyingMixes = mixes.filter(mix => {
      const likes = mix.likeCount || mix.likes || 0;
      return likes >= REQUIRED_LIKES;
    });
    
    log.info('[check-dj-eligibility] Qualifying mixes (10+ likes):', qualifyingMixes.length);
    
    if (qualifyingMixes.length === 0) {
      // Find the mix with the most likes to show progress
      const bestMix = mixes.reduce((best, current) => {
        const currentLikes = current.likeCount || current.likes || 0;
        const bestLikes = best.likeCount || best.likes || 0;
        return currentLikes > bestLikes ? current : best;
      }, mixes[0]);
      
      const bestLikes = bestMix.likeCount || bestMix.likes || 0;
      
      return successResponse({ eligible: false,
        reason: 'insufficient_likes',
        message: `Your mixes need at least ${REQUIRED_LIKES} likes to go live. Your best mix has ${bestLikes} like${bestLikes === 1 ? '' : 's'}.`,
        mixCount: mixes.length,
        qualifyingMixes: 0,
        bestMixLikes: bestLikes,
        requiredLikes: REQUIRED_LIKES,
        likesNeeded: REQUIRED_LIKES - bestLikes,
        bypassRequest });
    }
    
    // DJ is eligible!
    return successResponse({ eligible: true,
      mixCount: mixes.length,
      qualifyingMixes: qualifyingMixes.length,
      requiredLikes: REQUIRED_LIKES });
    
  } catch (error: unknown) {
    log.error('[check-dj-eligibility] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to check eligibility');
  }
};
