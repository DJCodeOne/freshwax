import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, addDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse, jsonResponse, errorResponse} from '../../../lib/api-utils';

const log = createLogger('dj/eligibility');
import { z } from 'zod';

const EligibilitySchema = z.object({
  action: z.enum(['checkAndUpdate', 'requestBypass']),
  uid: z.string().min(1).max(200),
  reason: z.string().max(2000).nullish(),
}).passthrough();

// Default requirements (can be overridden by admin settings)
const DEFAULT_REQUIREMENTS = {
  requiredMixes: 1,
  requiredLikes: 10,
  allowBypassRequests: true
};

// Get admin settings
async function getSettings() {
  try {
    const settings = await getDocument('system', 'admin-settings');
    if (settings) {
      return {
        requiredMixes: settings?.livestream?.requiredMixes ?? DEFAULT_REQUIREMENTS.requiredMixes,
        requiredLikes: settings?.livestream?.requiredLikes ?? DEFAULT_REQUIREMENTS.requiredLikes,
        allowBypassRequests: settings?.livestream?.allowBypassRequests ?? DEFAULT_REQUIREMENTS.allowBypassRequests
      };
    }
  } catch (error: unknown) {
    log.error('Error loading settings:', error);
  }
  return DEFAULT_REQUIREMENTS;
}

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dj-eligibility:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');

  try {
    // Check DJ eligibility
    if (action === 'checkEligibility' && uid) {
      // SECURITY: Verify the user is checking their own eligibility
      const { userId: verifiedUid } = await verifyRequestUser(request).catch(() => ({ userId: null }));
      if (!verifiedUid || verifiedUid !== uid) {
        return ApiErrors.unauthorized('Authentication required');
      }
      const settings = await getSettings();

      // Check for bypass in djLobbyBypass collection first (publicly readable)
      const bypassDoc = await getDocument('djLobbyBypass', uid);
      if (bypassDoc) {
        return successResponse({ eligible: true,
          reason: 'bypass_granted',
          canAccessLobby: true,
          canBook: true,
          canGoLive: true
        });
      }

      // Try to get user document (may fail if not authenticated)
      let userData: Record<string, unknown> | null = null;
      try {
        userData = await getDocument('users', uid);
      } catch (e: unknown) {
        // Users collection requires auth - this is ok, we'll check other criteria
      }

      // If already eligible via role, return true
      if (userData?.roles?.djEligible) {
        return successResponse({ eligible: true,
          reason: 'already_eligible',
          canAccessLobby: true,
          canBook: true,
          canGoLive: true
        });
      }

      // If has bypass flag in user doc, return true
      if (userData?.['go-liveBypassed'] === true) {
        return successResponse({ eligible: true,
          reason: 'bypass_granted',
          canAccessLobby: true,
          canBook: true,
          canGoLive: true
        });
      }

      // Check mix count and likes
      const mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: uid }]
      });

      let totalMixes = 0;
      let mixesWithEnoughLikes = 0;
      let highestLikes = 0;
      let mixProgress: { id: string; title: unknown; likes: number; meetsThreshold: boolean }[] = [];

      mixes.forEach(mix => {
        totalMixes++;
        const likes = mix.likes || 0;
        highestLikes = Math.max(highestLikes, likes);
        
        if (likes >= settings.requiredLikes) {
          mixesWithEnoughLikes++;
        }

        mixProgress.push({
          id: mix.id,
          title: mix.title,
          likes: likes,
          meetsThreshold: likes >= settings.requiredLikes
        });
      });

      const meetsRequirements = totalMixes >= settings.requiredMixes && mixesWithEnoughLikes >= settings.requiredMixes;

      // Check bypass request status
      const bypassStatus = userData?.pendingRoles?.djBypass?.status || null;
      const hasPendingBypass = bypassStatus === 'pending';
      const bypassApproved = bypassStatus === 'approved';

      return successResponse({ eligible: meetsRequirements || bypassApproved,
        meetsRequirements,
        bypassApproved,
        hasPendingBypass,
        canRequestBypass: settings.allowBypassRequests && !hasPendingBypass && !bypassApproved && !meetsRequirements,
        requirements: {
          requiredMixes: settings.requiredMixes,
          requiredLikes: settings.requiredLikes
        },
        progress: {
          totalMixes,
          mixesWithEnoughLikes,
          highestLikes,
          mixes: mixProgress
        },
        canAccessLobby: meetsRequirements || bypassApproved,
        canBook: meetsRequirements || bypassApproved,
        canGoLive: meetsRequirements || bypassApproved
      });
    }

    // Get requirements only
    if (action === 'getRequirements') {
      const settings = await getSettings();
      return successResponse({ requirements: settings
      });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('DJ Eligibility API GET error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: write operations - 30 per minute
  const clientId2 = getClientId(request);
  const rl = checkRateLimit(`dj-eligibility-write:${clientId2}`, RateLimiters.write);
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter!);
  }  try {
    // SECURITY: Verify Firebase token for all POST actions
    const { userId: verifiedUid, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUid) {
      return ApiErrors.unauthorized('Authentication required');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = EligibilitySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const body = parseResult.data;
    const { action, uid, reason } = body;

    // Check and update eligibility (called after a mix gets likes)
    if (action === 'checkAndUpdate') {
      if (!uid) {
        return ApiErrors.badRequest('Missing uid');
      }

      // SECURITY: Verify the user is checking their own eligibility
      if (verifiedUid !== uid) {
        return ApiErrors.forbidden('Cannot update eligibility for another user');
      }

      const settings = await getSettings();

      // Get user document
      const userData = await getDocument('users', uid);

      if (!userData) {
        return ApiErrors.notFound('User not found');
      }
      
      // If already eligible, no action needed
      if (userData?.roles?.djEligible) {
        return successResponse({ eligible: true,
          updated: false,
          message: 'Already eligible'
        });
      }

      // Check mix count and likes
      const mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: uid }]
      });

      let mixesWithEnoughLikes = 0;

      mixes.forEach(mix => {
        if ((mix.likes || 0) >= settings.requiredLikes) {
          mixesWithEnoughLikes++;
        }
      });

      const meetsRequirements = mixes.length >= settings.requiredMixes && mixesWithEnoughLikes >= settings.requiredMixes;

      if (meetsRequirements) {
        // Auto-grant DJ eligibility
        await updateDocument('users', uid, {
          'roles.djEligible': true,
          updatedAt: new Date()
        });

        // Create notification
        await addDocument('notifications', {
          userId: uid,
          type: 'dj_eligible',
          title: 'DJ Status Unlocked! 🎧',
          message: 'Congratulations! You now have access to the DJ Lobby and can book livestream slots.',
          read: false,
          createdAt: new Date()
        });

        return successResponse({ eligible: true,
          updated: true,
          message: 'DJ eligibility granted!'
        });
      }

      return successResponse({ eligible: false,
        updated: false,
        progress: {
          mixesWithEnoughLikes,
          required: settings.requiredMixes
        }
      });
    }

    // Request bypass
    if (action === 'requestBypass') {
      if (!uid) {
        return ApiErrors.badRequest('Missing uid');
      }

      // SECURITY: Verify the user is requesting bypass for themselves
      if (verifiedUid !== uid) {
        return ApiErrors.forbidden('Cannot request bypass for another user');
      }

      const settings = await getSettings();

      if (!settings.allowBypassRequests) {
        return ApiErrors.badRequest('Bypass requests are currently disabled');
      }

      const userData = await getDocument('users', uid);

      if (!userData) {
        return ApiErrors.notFound('User not found');
      }

      // Check if already eligible
      if (userData?.roles?.djEligible) {
        return ApiErrors.badRequest('Already DJ eligible');
      }

      // Check if already has pending request
      if (userData?.pendingRoles?.djBypass?.status === 'pending') {
        return ApiErrors.badRequest('Bypass request already pending');
      }

      // Submit bypass request
      await updateDocument('users', uid, {
        'pendingRoles.djBypass': {
          requestedAt: new Date(),
          status: 'pending',
          reason: reason || ''
        },
        updatedAt: new Date()
      });

      return successResponse({ message: 'Bypass request submitted'
      });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('DJ Eligibility API POST error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
