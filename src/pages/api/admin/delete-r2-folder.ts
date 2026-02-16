// src/pages/api/admin/delete-r2-folder.ts
// Delete a folder and all its contents from R2

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

const deleteR2FolderSchema = z.object({
  folder: z.string().min(1),
}).passthrough();

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`delete-r2-folder:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const body = await request.json();
    const parsed = deleteR2FolderSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { folder } = parsed.data;

    const r2: R2Bucket = locals.runtime.env.R2;

    // List all objects in the folder
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
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
      return new Response(JSON.stringify({ message: 'Folder is empty or does not exist', deleted: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Batch delete all objects (r2.delete accepts an array of keys)
    await r2.delete(keys);

    return new Response(JSON.stringify({
      success: true,
      message: `Deleted ${keys.length} files from ${folder}`,
      deleted: keys.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[delete-r2-folder] Error:', error);
    return ApiErrors.serverError('Failed to delete folder');
  }
};
