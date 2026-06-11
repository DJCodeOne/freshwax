// src/pages/api/list-submissions.ts
// List pending release submissions from R2

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../lib/admin';
import { ApiErrors, createLogger, jsonResponse } from '../../lib/api-utils';
import { queryCollection } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const log = createLogger('list-submissions');

// True when a release was already created from this submission. Processing
// normally deletes the submission folder, but keeps it on a track-count
// mismatch — without this check those folders sit in "Pending" forever.
async function isAlreadyProcessed(submissionId: string): Promise<boolean> {
  try {
    const matches = await queryCollection('releases', {
      filters: [{ field: 'submissionId', op: 'EQUAL', value: submissionId }],
      limit: 1,
      skipCache: true,
    });
    return matches.length > 0;
  } catch (e: unknown) {
    log.warn(`Could not check release for submission ${submissionId}:`, e);
    return false; // on lookup failure, keep showing the submission
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`list-submissions:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin-only: lists R2 submission folders containing artist names
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const r2: R2Bucket = locals.runtime.env.R2;
    const submissions: string[] = [];

    // Check submissions/ folder first
    const submissionsResult = await r2.list({ prefix: 'submissions/', delimiter: '/' });

    for (const prefix of submissionsResult.delimitedPrefixes) {
      // prefix looks like "submissions/foldername/" — extract folder name
      const folder = prefix.replace(/^submissions\//, '').replace(/\/$/, '');
      if (!folder.startsWith('test-')) {
        submissions.push(folder);
      }
    }

    // Also check root level for submission-like folders (Artist-timestamp pattern)
    const rootResult = await r2.list({ delimiter: '/' });

    for (const prefix of rootResult.delimitedPrefixes) {
      // prefix looks like "foldername/" — strip trailing slash
      const folder = prefix.replace(/\/$/, '');
      // Match pattern like "Artist_Name-1234567890" (name + timestamp)
      if (/^[A-Za-z0-9_]+-\d{10,}$/.test(folder) && !folder.startsWith('test-')) {
        // Check if this folder has an info.json (confirms it's a submission)
        const infoCheck = await r2.head(`${folder}/info.json`);
        if (infoCheck) {
          submissions.push(`root:${folder}`);
        } else {
          const metaCheck = await r2.head(`${folder}/metadata.json`);
          if (metaCheck) {
            submissions.push(`root:${folder}`);
          }
        }
      }
    }

    // Hide submissions that already became a release (leftover folders)
    const checks = await Promise.all(
      submissions.map(async (s) => ({
        s,
        processed: await isAlreadyProcessed(s.replace(/^root:/, '')),
      }))
    );
    const pending = checks.filter((c) => !c.processed).map((c) => c.s);
    const skipped = checks.length - pending.length;
    if (skipped > 0) log.info(`Hiding ${skipped} already-processed submission folder(s)`);

    return jsonResponse({ submissions: pending });

  } catch (error: unknown) {
    log.error('[list-submissions] Error:', error);
    return ApiErrors.serverError('Failed to list submissions');
  }
};
