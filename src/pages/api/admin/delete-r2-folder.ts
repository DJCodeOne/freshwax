// src/pages/api/admin/delete-r2-folder.ts
// Delete a folder and all its contents from R2

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`delete-r2-folder:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const { folder } = await request.json();

    if (!folder) {
      return new Response(JSON.stringify({ error: 'Folder name required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const r2: R2Bucket = (locals as any).runtime.env.R2;

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
    return new Response(JSON.stringify({
      error: 'Failed to delete folder'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
