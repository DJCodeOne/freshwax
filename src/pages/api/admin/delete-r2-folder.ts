// src/pages/api/admin/delete-r2-folder.ts
// Delete a folder and all its contents from R2

import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { requireAdminAuth } from '../../../lib/admin';

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: 'freshwax-releases',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const { folder } = await request.json();

    if (!folder) {
      return new Response(JSON.stringify({ error: 'Folder name required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = (locals as any)?.runtime?.env;
    const R2_CONFIG = getR2Config(env);

    if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      return new Response(JSON.stringify({ error: 'R2 not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const awsClient = new AwsClient({
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`;

    // List all objects in the folder
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    const listUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listResponse = await awsClient.fetch(listUrl);

    if (!listResponse.ok) {
      return new Response(JSON.stringify({ error: 'Failed to list folder contents' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const xmlText = await listResponse.text();
    const keys = [...xmlText.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);

    if (keys.length === 0) {
      return new Response(JSON.stringify({ message: 'Folder is empty or does not exist', deleted: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Delete each object
    let deleted = 0;
    for (const key of keys) {
      const deleteUrl = `${endpoint}/${R2_CONFIG.bucketName}/${encodeURIComponent(key)}`;
      const deleteResponse = await awsClient.fetch(deleteUrl, { method: 'DELETE' });
      if (deleteResponse.ok || deleteResponse.status === 204) {
        deleted++;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Deleted ${deleted} files from ${folder}`,
      deleted
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[delete-r2-folder] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to delete folder'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
