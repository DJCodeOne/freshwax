// src/pages/api/get-release.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { getDocument, clearCache, verifyRequestUser } from '../../lib/firebase-rest';
import { normalizeRelease } from '../../lib/releases';
import { isAdmin as checkIsAdmin, getAdminUids, initAdminEnv } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('get-release');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-release:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  const url = new URL(request.url);
  const releaseId = url.searchParams.get('id');
  const noCache = url.searchParams.get('nocache');

  // SECURITY: Check admin status via verified Firebase token (not spoofable cookies)
  let isAdminUser = false;
  try {
    const { userId: verifiedUid } = await verifyRequestUser(request);
    if (verifiedUid) {
      isAdminUser = await checkIsAdmin(verifiedUid);
    }
  } catch (e: unknown) {
    // Not authenticated - that's OK for public release viewing
  }

  if (!releaseId) {
    return ApiErrors.badRequest('Release ID required');
  }

  log.info('[get-release] Fetching:', releaseId, noCache ? '(nocache)' : '', isAdminUser ? '(admin)' : '');
  
  // Clear cache for this release if nocache requested
  if (noCache) {
    clearCache(`doc:releases:${releaseId}`);
  }
  
  try {
    const release = await getDocument('releases', releaseId);
    
    if (!release) {
      log.info('[get-release] Not found:', releaseId);
      return ApiErrors.notFound('Release not found');
    }
    
    // Only check status for public requests (non-admin)
    if (!isAdminUser && release.status !== 'live') {
      log.info('[get-release] Not live:', releaseId, release.status);
      return ApiErrors.notFound('Release not available');
    }
    
    const normalized = normalizeRelease(release, releaseId);

    // Fetch artist bio from users collection if artistId exists
    let artistBio = '';
    if (normalized.artistId) {
      try {
        const userDoc = await getDocument('users', normalized.artistId);
        if (userDoc?.pendingRoles?.artist?.bio) {
          const bio = userDoc.pendingRoles.artist.bio.trim();
          // Skip placeholder/default bios
          const placeholderBios = [
            'electronic music / digital and vinyl',
            'electronic music digital and vinyl'
          ];
          if (!placeholderBios.includes(bio.toLowerCase())) {
            artistBio = bio;
          }
        }
      } catch (err: unknown) {
        log.info('[get-release] Could not fetch artist bio:', err);
      }
    }

    log.info('[get-release] Returning:', normalized.artistName, '-', normalized.releaseName, artistBio ? '(has bio)' : '(no bio)');

    return successResponse({ release: { ...normalized, artistBio },
      source: 'firebase-rest' }, 200, { headers: { 'Cache-Control': 'private, max-age=60, must-revalidate' } });
    
  } catch (error: unknown) {
    log.error('[get-release] Error:', error);
    return ApiErrors.serverError('Failed to fetch release');
  }
};