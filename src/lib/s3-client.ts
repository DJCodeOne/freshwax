// src/lib/s3-client.ts
// Shared S3 client factory for R2 storage access via @aws-sdk/client-s3

import './dom-polyfill'; // DOM polyfill for AWS SDK on Cloudflare Workers
import { S3Client } from '@aws-sdk/client-s3';
import type { getR2Config } from './api-utils';

/**
 * Create an S3-compatible client configured for Cloudflare R2.
 * Accepts the config object returned by getR2Config().
 */
export function createS3Client(config: ReturnType<typeof getR2Config>) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}
