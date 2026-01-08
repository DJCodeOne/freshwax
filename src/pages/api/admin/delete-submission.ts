// src/pages/api/admin/delete-submission.ts
// Delete a submission folder from R2 (for cleanup)

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
  try {
    const env = (locals as any)?.runtime?.env;
    const bodyData = await request.json();
    const { submissionId, location } = bodyData;

    // Admin auth - pass body for adminKey check
    const authError = requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    if (!submissionId) {
      return new Response(JSON.stringify({ error: 'submissionId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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
    const bucketUrl = `${endpoint}/${R2_CONFIG.bucketName}`;

    // Determine prefix based on location
    let prefix: string;
    if (location === 'submissions/') {
      prefix = `submissions/${submissionId}/`;
    } else if (location === 'root' || !location) {
      prefix = `${submissionId}/`;
    } else {
      prefix = `${location}${submissionId}/`;
    }

    // List all files in the folder
    const listUrl = `${bucketUrl}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listResponse = await awsClient.fetch(listUrl);
    const listXml = await listResponse.text();

    const keyMatches = listXml.matchAll(/<Key>([^<]+)<\/Key>/g);
    const files: string[] = [];
    for (const match of keyMatches) {
      files.push(match[1]);
    }

    if (files.length === 0) {
      return new Response(JSON.stringify({
        error: 'No files found',
        prefix,
        deleted: 0
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Delete all files
    let deleted = 0;
    for (const file of files) {
      const deleteUrl = `${bucketUrl}/${encodeURIComponent(file)}`;
      const deleteResponse = await awsClient.fetch(deleteUrl, { method: 'DELETE' });
      if (deleteResponse.ok || deleteResponse.status === 204) {
        deleted++;
        console.log(`[delete-submission] Deleted: ${file}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      submissionId,
      prefix,
      deleted,
      total: files.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[delete-submission] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to delete'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
