// Debug endpoint to see submission contents
import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const submissionId = url.searchParams.get('id') || 'Code_One-1765771210267';
    const env = (locals as any)?.runtime?.env;
    const R2_CONFIG = getR2Config(env);

    const awsClient = new AwsClient({
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`;
    const bucketUrl = `${endpoint}/${R2_CONFIG.bucketName}`;

    // List all files in submission
    const listUrl = `${bucketUrl}?list-type=2&prefix=submissions/${submissionId}/`;
    const listResponse = await awsClient.fetch(listUrl);
    const listXml = await listResponse.text();

    const keyMatches = listXml.matchAll(/<Key>([^<]+)<\/Key>/g);
    const files: string[] = [];
    for (const match of keyMatches) {
      files.push(match[1]);
    }

    // Get metadata
    const metadataKey = `submissions/${submissionId}/metadata.json`;
    const metadataUrl = `${bucketUrl}/${encodeURIComponent(metadataKey)}`;
    const metadataResponse = await awsClient.fetch(metadataUrl);

    let metadata = null;
    if (metadataResponse.ok) {
      metadata = await metadataResponse.json();
    }

    // Build expected URLs
    const audioFiles = files.filter(f => {
      const lower = f.toLowerCase();
      return lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.flac');
    });

    const expectedUrls = audioFiles.map(f => ({
      key: f,
      filename: f.split('/').pop(),
      url: `${R2_CONFIG.publicDomain}/${f}`,
    }));

    return new Response(JSON.stringify({
      submissionId,
      fileCount: files.length,
      files,
      audioFiles: audioFiles.length,
      expectedUrls,
      metadata,
      cdnDomain: R2_CONFIG.publicDomain,
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
