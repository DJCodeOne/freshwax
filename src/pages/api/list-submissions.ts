// src/pages/api/list-submissions.ts
// List pending release submissions from R2

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

export const GET: APIRoute = async ({ locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const R2_CONFIG = getR2Config(env);

    if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      return new Response(JSON.stringify({ error: 'R2 not configured', submissions: [] }), {
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
    const submissions: string[] = [];

    // Check submissions/ folder first
    const submissionsUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&prefix=submissions/&delimiter=/`;
    const submissionsResponse = await awsClient.fetch(submissionsUrl);

    if (submissionsResponse.ok) {
      const xmlText = await submissionsResponse.text();
      const prefixMatches = xmlText.matchAll(/<Prefix>submissions\/([^<]+)\/<\/Prefix>/g);

      for (const match of prefixMatches) {
        const folder = match[1];
        if (!folder.startsWith('test-')) {
          submissions.push(folder);
        }
      }
    }

    // Also check root level for submission-like folders (Artist-timestamp pattern)
    const rootUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&delimiter=/`;
    const rootResponse = await awsClient.fetch(rootUrl);

    if (rootResponse.ok) {
      const rootXml = await rootResponse.text();
      // Look for folders at root level that match submission pattern
      const rootPrefixes = rootXml.matchAll(/<Prefix>([^<\/]+)\/<\/Prefix>/g);

      for (const match of rootPrefixes) {
        const folder = match[1];
        // Match pattern like "Artist_Name-1234567890" (name + timestamp)
        if (/^[A-Za-z0-9_]+-\d{10,}$/.test(folder) && !folder.startsWith('test-')) {
          // Check if this folder has a metadata.json (confirms it's a submission)
          const metaCheckUrl = `${endpoint}/${R2_CONFIG.bucketName}/${folder}/metadata.json`;
          const metaCheck = await awsClient.fetch(metaCheckUrl, { method: 'HEAD' });
          if (metaCheck.ok) {
            submissions.push(`root:${folder}`); // Prefix with root: to indicate location
          }
        }
      }
    }

    return new Response(JSON.stringify({ submissions }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[list-submissions] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to list submissions',
      submissions: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
