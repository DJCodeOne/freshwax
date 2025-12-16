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
    const listUrl = `${endpoint}/${R2_CONFIG.bucketName}?list-type=2&prefix=submissions/&delimiter=/`;

    const response = await awsClient.fetch(listUrl);

    if (!response.ok) {
      throw new Error('Failed to list bucket');
    }

    const xmlText = await response.text();

    // Parse common prefixes (folders) from XML
    const prefixMatches = xmlText.matchAll(/<Prefix>submissions\/([^<]+)\/<\/Prefix>/g);
    const submissions: string[] = [];

    for (const match of prefixMatches) {
      const folder = match[1];
      // Skip test folders
      if (!folder.startsWith('test-')) {
        submissions.push(folder);
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
