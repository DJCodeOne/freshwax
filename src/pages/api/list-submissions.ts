// src/pages/api/list-submissions.ts
// List pending release submissions from R2

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../lib/admin';
import { ApiErrors } from '../../lib/api-utils';

export const GET: APIRoute = async ({ request, locals }) => {
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

    return new Response(JSON.stringify({ submissions }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[list-submissions] Error:', error);
    return ApiErrors.serverError('Failed to list submissions');
  }
};
