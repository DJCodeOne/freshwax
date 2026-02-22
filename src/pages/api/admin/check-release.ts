// src/pages/api/admin/check-release.ts
// Check release submitter info

import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-release:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const runtimeEnv = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: runtimeEnv?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: runtimeEnv?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const saQuery = getSaQuery(locals);

  // SECURITY: Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const search = url.searchParams.get('search') || 'ultron';

  try {
    const releases = await queryCollection('releases', { limit: 100, cacheTime: 60000 });

    // Find releases matching search
    const matches = releases.filter((r: Record<string, unknown>) =>
      (r.title || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.artistName || '').toLowerCase().includes(search.toLowerCase())
    );

    const details = matches.map((r: Record<string, unknown>) => ({
      id: r.id,
      title: r.title,
      artistName: r.artistName,
      submitterId: r.submitterId,
      uploadedBy: r.uploadedBy,
      userId: r.userId,
      email: r.email,
      submitterEmail: r.submitterEmail,
      labelName: r.labelName,
      // Show all fields that might indicate owner
      allOwnerFields: {
        submitterId: r.submitterId,
        uploadedBy: r.uploadedBy,
        userId: r.userId,
        submittedBy: r.submittedBy,
        createdBy: r.createdBy,
        ownerId: r.ownerId
      }
    }));

    // Also look up artists/users to find y2
    const artists = await saQuery('artists', { limit: 100, cacheTime: 60000 });
    const y2Artist = artists.filter((a: Record<string, unknown>) =>
      (a.name || '').toLowerCase().includes('y2') ||
      (a.displayName || '').toLowerCase().includes('y2')
    );

    return new Response(JSON.stringify({
      success: true,
      searchTerm: search,
      matchingReleases: details,
      y2Artists: y2Artist.map((a: Record<string, unknown>) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        email: a.email,
        userId: a.userId
      }))
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    return ApiErrors.serverError('Failed to check releases');
  }
};
