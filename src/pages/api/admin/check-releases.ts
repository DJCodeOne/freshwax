// src/pages/api/admin/check-releases.ts
// Diagnostic endpoint to check release ownership fields

import type { APIRoute } from 'astro';

import { saQueryCollection } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-releases:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;

  // SECURITY: Require admin authentication
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    const releases = await saQueryCollection(serviceAccountKey, projectId, 'releases', {
      limit: 100
    });

    const summary = releases.map((r: any) => ({
      id: r.id,
      artistName: r.artistName || r.artist,
      releaseName: r.releaseName || r.title,
      submitterEmail: r.submitterEmail || r.email || 'NOT SET',
      submitterId: r.submitterId || 'NOT SET',
      uploadedBy: r.uploadedBy || 'NOT SET',
      userId: r.userId || 'NOT SET',
      status: r.status
    }));

    // If userId provided, check which would match
    let matchesForUser = null;
    if (userId) {
      matchesForUser = {
        bySubmitterId: releases.filter((r: any) => r.submitterId === userId).length,
        byUploadedBy: releases.filter((r: any) => r.uploadedBy === userId).length,
        byUserId: releases.filter((r: any) => r.userId === userId).length,
        totalMatches: releases.filter((r: any) =>
          r.submitterId === userId || r.uploadedBy === userId || r.userId === userId
        ).map((r: any) => r.releaseName || r.title)
      };
    }

    return new Response(JSON.stringify({
      totalReleases: releases.length,
      releases: summary,
      matchesForUser
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    return ApiErrors.serverError('Failed to check releases');
  }
};
