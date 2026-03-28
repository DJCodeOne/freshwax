// src/pages/api/stream/list-djs.ts
// List approved DJs who can go live
// Optimized: Uses batch fetch for user profiles to avoid N+1 queries
import type { APIRoute } from 'astro';
import { queryCollection, getDocumentsBatch } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('stream/list-djs');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stream-list-djs:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  const url = new URL(request.url);
  const approvedOnly = url.searchParams.get('approved') === 'true';

  try {
    // Get DJs from djLobbyBypass collection (those granted access)
    const bypassDocs = await queryCollection('djLobbyBypass', {
      orderBy: { field: 'grantedAt', direction: 'DESCENDING' },
      limit: 50
    });

    // OPTIMIZATION: Collect all user IDs and batch fetch user profiles
    // instead of N individual getDocument calls (was N+1 pattern)
    const userIds = bypassDocs.map(doc => doc.id).filter(Boolean);
    const userMap = userIds.length > 0
      ? await getDocumentsBatch('users', userIds)
      : new Map<string, Record<string, unknown>>();

    log.info('[list-djs] Batch fetched', userMap.size, 'user profiles for', bypassDocs.length, 'DJs');

    // Fetch last stream for each DJ in parallel (queryCollection per DJ unavoidable
    // since each needs a different userId filter, but at least run them concurrently)
    const streamResults = await Promise.allSettled(
      bypassDocs.map(doc =>
        queryCollection('livestreams', {
          filters: [{ field: 'userId', op: 'EQUAL', value: doc.id }],
          orderBy: { field: 'startedAt', direction: 'DESCENDING' },
          limit: 1
        }).catch(() => [] as Record<string, unknown>[])
      )
    );

    const djs = bypassDocs.map((doc, index) => {
      const data = doc;
      const userId = doc.id;

      // Get user info from batch-fetched map (no individual query needed)
      let djName = data.name || data.email?.split('@')[0] || 'Unknown DJ';
      let email = data.email || '';

      const userDoc = userMap.get(userId);
      if (userDoc) {
        djName = (userDoc.displayName || userDoc.name || djName) as string;
        email = (userDoc.email || email) as string;
      }

      // Get last stream from parallel-fetched results
      let lastStreamAt = null;
      const streamResult = streamResults[index];
      if (streamResult.status === 'fulfilled' && streamResult.value.length > 0) {
        const streamData = streamResult.value[0];
        lastStreamAt = streamData.startedAt instanceof Date
          ? streamData.startedAt.toISOString()
          : streamData.startedAt || null;
      }

      return {
        userId,
        djName,
        email,
        grantedAt: data.grantedAt instanceof Date
          ? data.grantedAt.toISOString()
          : data.grantedAt || null,
        reason: data.reason || null,
        lastStreamAt,
        // Placeholder values for Icecast integration
        icecastMountPoint: `/live/${userId.substring(0, 8)}`,
        twitchChannel: null
      };
    });

    return successResponse({ djs });

  } catch (error: unknown) {
    log.error('[list-djs] Error:', error instanceof Error ? error.message : String(error));
    return successResponse({ djs: [],
      error: 'Internal error' });
  }
};
