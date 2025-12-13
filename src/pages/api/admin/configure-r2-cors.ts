// src/pages/api/admin/configure-r2-cors.ts
// One-time setup endpoint to configure CORS on R2 bucket for browser uploads

import type { APIRoute } from 'astro';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

export const prerender = false;

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  };
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    const env = (locals as any).runtime?.env;
    const r2Config = getR2Config(env);

    if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'R2 credentials not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });

    // Get current CORS configuration
    try {
      const currentCors = await s3Client.send(new GetBucketCorsCommand({
        Bucket: r2Config.bucketName,
      }));

      return new Response(JSON.stringify({
        success: true,
        bucket: r2Config.bucketName,
        corsRules: currentCors.CORSRules || [],
      }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err: any) {
      if (err.name === 'NoSuchCORSConfiguration') {
        return new Response(JSON.stringify({
          success: true,
          bucket: r2Config.bucketName,
          corsRules: [],
          message: 'No CORS configuration set. Use POST to configure.'
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw err;
    }

  } catch (error) {
    console.error('Failed to get CORS config:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get CORS config'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const POST: APIRoute = async ({ locals }) => {
  try {
    const env = (locals as any).runtime?.env;
    const r2Config = getR2Config(env);

    if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'R2 credentials not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });

    // Set CORS configuration to allow browser uploads
    const corsConfig = {
      Bucket: r2Config.bucketName,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ['*'],
            AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
            AllowedOrigins: ['*'], // In production, restrict to your domain
            ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    };

    await s3Client.send(new PutBucketCorsCommand(corsConfig));

    return new Response(JSON.stringify({
      success: true,
      message: 'CORS configured successfully',
      bucket: r2Config.bucketName,
      corsRules: corsConfig.CORSConfiguration.CORSRules,
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Failed to configure CORS:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to configure CORS'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
