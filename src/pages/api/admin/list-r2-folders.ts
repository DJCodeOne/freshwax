// src/pages/api/admin/list-r2-folders.ts
// Debug endpoint to list ALL folders in R2 bucket

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

export const GET: APIRoute = async ({ request, locals }) => {
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
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
    const folders: { name: string; location: string }[] = [];

    // List ALL folders at root level
    const rootUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&delimiter=/`;
    const rootResponse = await awsClient.fetch(rootUrl);

    if (rootResponse.ok) {
      const rootXml = await rootResponse.text();
      const rootPrefixes = rootXml.matchAll(/<Prefix>([^<\/]+)\/<\/Prefix>/g);

      for (const match of rootPrefixes) {
        folders.push({ name: match[1], location: 'root' });
      }
    }

    // List ALL folders in submissions/
    const submissionsUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&prefix=submissions/&delimiter=/`;
    const submissionsResponse = await awsClient.fetch(submissionsUrl);

    if (submissionsResponse.ok) {
      const subXml = await submissionsResponse.text();
      const subPrefixes = subXml.matchAll(/<Prefix>submissions\/([^<]+)\/<\/Prefix>/g);

      for (const match of subPrefixes) {
        folders.push({ name: match[1], location: 'submissions/' });
      }
    }

    // List ALL folders in releases/
    const releasesUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&prefix=releases/&delimiter=/`;
    const releasesResponse = await awsClient.fetch(releasesUrl);

    if (releasesResponse.ok) {
      const relXml = await releasesResponse.text();
      const relPrefixes = relXml.matchAll(/<Prefix>releases\/([^<]+)\/<\/Prefix>/g);

      for (const match of relPrefixes) {
        folders.push({ name: match[1], location: 'releases/' });
      }
    }

    return new Response(JSON.stringify({ folders, count: folders.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[list-r2-folders] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to list folders'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
