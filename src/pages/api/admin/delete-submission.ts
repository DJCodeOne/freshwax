// src/pages/api/admin/delete-submission.ts
// Delete a submission folder from R2 (for cleanup)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors, successResponse } from '../../../lib/api-utils';

const log = createLogger('[delete-submission]');

export const prerender = false;

const deleteSubmissionSchema = z.object({
  submissionId: z.string().min(1),
  location: z.string().optional(),
  adminKey: z.string().optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`delete-submission:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const bodyData = await request.json();

    // Admin auth - pass body for adminKey check
    const authError = await requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    const parsed = deleteSubmissionSchema.safeParse(bodyData);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { submissionId, location } = parsed.data;

    const r2: R2Bucket = locals.runtime.env.R2;

    // Determine prefix based on location
    let prefix: string;
    if (location === 'submissions/') {
      prefix = `submissions/${submissionId}/`;
    } else if (location === 'root' || !location) {
      prefix = `${submissionId}/`;
    } else {
      prefix = `${location}${submissionId}/`;
    }

    // List all files in the folder (handle pagination)
    const keys: string[] = [];
    let cursor: string | undefined;
    let truncated = true;
    while (truncated) {
      const listResult = await r2.list({ prefix, cursor });
      for (const obj of listResult.objects) {
        keys.push(obj.key);
      }
      truncated = listResult.truncated;
      cursor = listResult.truncated ? listResult.cursor : undefined;
    }

    if (keys.length === 0) {
      return ApiErrors.notFound('No files found');
    }

    // Batch delete all files
    await r2.delete(keys);
    log.info(`Deleted ${keys.length} files from ${prefix}`);

    return successResponse({ submissionId,
      prefix,
      deleted: keys.length,
      total: keys.length });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to delete');
  }
};
