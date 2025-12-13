// src/pages/api/list-r2-files.ts
// Lists files in R2 bucket for a specific release

import '../../lib/dom-polyfill'; // DOM polyfill for AWS SDK on Cloudflare Workers
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const GET = async ({ url, locals }: any) => {
  try {
    const releaseId = url.searchParams.get('releaseId');
    
    if (!releaseId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Missing releaseId parameter' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = locals?.runtime?.env || {};
    const accountId = env.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID;
    const accessKeyId = env.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY;
    const bucketName = env.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases';
    const publicDomain = env.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'R2 credentials not configured' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `releases/${releaseId}/`,
    });

    const response = await r2Client.send(command);
    
    const files = (response.Contents || []).map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
      url: `${publicDomain}/${obj.Key}`
    }));

    // Group by folder
    const grouped = {
      artwork: files.filter(f => f.key?.includes('/artwork/')),
      previews: files.filter(f => f.key?.includes('/previews/')),
      tracks: files.filter(f => f.key?.includes('/tracks/')),
      other: files.filter(f => !f.key?.includes('/artwork/') && !f.key?.includes('/previews/') && !f.key?.includes('/tracks/'))
    };

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      totalFiles: files.length,
      files,
      grouped
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[list-r2-files] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list files'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
