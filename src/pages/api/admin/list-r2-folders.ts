// src/pages/api/admin/list-r2-folders.ts
// Debug endpoint to list ALL folders in R2 bucket

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('admin/list-r2-folders');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`list-r2-folders:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const r2: R2Bucket = locals.runtime.env.R2;
    const folders: { name: string; location: string }[] = [];

    // List ALL folders at root level
    const rootResult = await r2.list({ delimiter: '/' });

    for (const prefix of rootResult.delimitedPrefixes) {
      // prefix looks like "foldername/" — strip trailing slash
      const name = prefix.replace(/\/$/, '');
      folders.push({ name, location: 'root' });
    }

    // List ALL folders in submissions/
    const submissionsResult = await r2.list({ prefix: 'submissions/', delimiter: '/' });

    for (const prefix of submissionsResult.delimitedPrefixes) {
      // prefix looks like "submissions/foldername/" — extract folder name
      const name = prefix.replace(/^submissions\//, '').replace(/\/$/, '');
      folders.push({ name, location: 'submissions/' });
    }

    // List ALL folders in releases/
    const releasesResult = await r2.list({ prefix: 'releases/', delimiter: '/' });

    for (const prefix of releasesResult.delimitedPrefixes) {
      // prefix looks like "releases/foldername/" — extract folder name
      const name = prefix.replace(/^releases\//, '').replace(/\/$/, '');
      folders.push({ name, location: 'releases/' });
    }

    return jsonResponse({ folders, count: folders.length });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to list folders');
  }
};
