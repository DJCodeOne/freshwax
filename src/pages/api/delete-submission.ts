// src/pages/api/delete-submission.ts
// Delete a pending submission from R2

import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: 'freshwax-releases',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const R2_CONFIG = getR2Config(env);

    if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      return new Response(JSON.stringify({ error: 'R2 not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { submission } = body;

    if (!submission) {
      return new Response(JSON.stringify({ error: 'Missing submission parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[delete-submission] Deleting:', submission);

    const awsClient = new AwsClient({
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`;

    // Determine the folder path
    const isRootLevel = submission.startsWith('root:');
    const folderName = isRootLevel ? submission.replace('root:', '') : submission;
    const prefix = isRootLevel ? `${folderName}/` : `submissions/${folderName}/`;

    // List all objects in the folder
    const listUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listResponse = await awsClient.fetch(listUrl);

    if (!listResponse.ok) {
      console.error('[delete-submission] Failed to list objects:', await listResponse.text());
      return new Response(JSON.stringify({ error: 'Failed to list submission files' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const xmlText = await listResponse.text();
    const keyMatches = xmlText.matchAll(/<Key>([^<]+)<\/Key>/g);
    const keysToDelete: string[] = [];

    for (const match of keyMatches) {
      keysToDelete.push(match[1]);
    }

    console.log('[delete-submission] Found', keysToDelete.length, 'files to delete');

    // Delete each object
    let deleted = 0;
    for (const key of keysToDelete) {
      const deleteUrl = `${endpoint}/${R2_CONFIG.bucketName}/${encodeURIComponent(key)}`;
      const deleteResponse = await awsClient.fetch(deleteUrl, { method: 'DELETE' });

      if (deleteResponse.ok || deleteResponse.status === 204) {
        deleted++;
        console.log('[delete-submission] Deleted:', key);
      } else {
        console.error('[delete-submission] Failed to delete:', key, deleteResponse.status);
      }
    }

    console.log('[delete-submission] Deleted', deleted, '/', keysToDelete.length, 'files');

    return new Response(JSON.stringify({
      success: true,
      deleted,
      total: keysToDelete.length,
      submission: folderName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[delete-submission] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to delete submission'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
