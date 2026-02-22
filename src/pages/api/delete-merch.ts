// src/pages/api/delete-merch.ts
// Delete a merch product - removes from Firebase and R2

import '../../lib/dom-polyfill'; // DOM polyfill for AWS SDK on Cloudflare Workers
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { S3Client, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDocument, clearCache } from '../../lib/firebase-rest';
import { saUpdateDocument, saDeleteDocument, saAddDocument, getServiceAccountKeyWithProject } from '../../lib/firebase-service-account';
import { d1DeleteMerch } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { requireAdminAuth } from '../../lib/admin';
import { ApiErrors, createLogger, getR2Config } from '../../lib/api-utils';

const deleteMerchSchema = z.object({
  productId: z.string().min(1),
});

const logger = createLogger('delete-merch');

export const prerender = false;


// Create S3 client with runtime env
function createS3Client(config: ReturnType<typeof getR2Config>) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit: destructive operations - 3 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-merch:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    const body = await request.json();
    const parsed = deleteMerchSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { productId } = parsed.data;

    logger.info('[delete-merch] Deleting product:', productId);

    const product = await getDocument('merch', productId);

    if (!product) {
      return ApiErrors.notFound('Product not found');
    }

    // Delete images from R2
    if (product.r2FolderPath) {
      logger.info('[delete-merch] Deleting R2 folder:', product.r2FolderPath);

      try {
        const listResult = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: R2_CONFIG.bucketName,
            Prefix: product.r2FolderPath + '/'
          })
        );

        if (listResult.Contents && listResult.Contents.length > 0) {
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: R2_CONFIG.bucketName,
              Delete: {
                Objects: listResult.Contents.map(obj => ({ Key: obj.Key }))
              }
            })
          );
          logger.info('[delete-merch] Deleted', listResult.Contents.length, 'files from R2');
        }
      } catch (r2Error: unknown) {
        logger.error('[delete-merch] R2 deletion error:', r2Error);
      }
    }

    // Get service account credentials
    const { key: serviceAccountKey, projectId } = getServiceAccountKeyWithProject(env);

    // Update supplier stats if applicable
    if (product.supplierId) {
      try {
        const supplierData = await getDocument('merch-suppliers', product.supplierId);
        if (supplierData) {
          await saUpdateDocument(serviceAccountKey, projectId, 'merch-suppliers', product.supplierId, {
            totalProducts: (supplierData.totalProducts || 0) - 1,
            totalStock: (supplierData.totalStock || 0) - (product.totalStock || 0),
            updatedAt: new Date().toISOString()
          });
          logger.info('[delete-merch] Updated supplier stats');
        }
      } catch (e: unknown) {
        logger.info('[delete-merch] Could not update supplier stats');
      }
    }

    // Log the deletion
    await saAddDocument(serviceAccountKey, projectId, 'merch-stock-movements', {
      productId: productId,
      productName: product.name,
      sku: product.sku,
      type: 'deleted',
      quantity: -(product.totalStock || 0),
      previousStock: product.totalStock || 0,
      newStock: 0,
      notes: 'Product deleted from system',
      supplierId: product.supplierId || null,
      supplierName: product.supplierName || null,
      createdAt: new Date().toISOString(),
      createdBy: 'admin'
    });

    await saDeleteDocument(serviceAccountKey, projectId, 'merch', productId);

    // Also delete from D1 if available
    const db = env?.DB;
    if (db) {
      try {
        await d1DeleteMerch(db, productId);
        logger.info('[delete-merch] Also deleted from D1');
      } catch (d1Error: unknown) {
        logger.error('[delete-merch] D1 deletion failed (non-critical):', d1Error);
      }
    }

    // Clear merch cache so the list refreshes
    clearCache('merch');
    clearCache('live-merch');

    logger.info('[delete-merch] Product deleted:', productId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Product deleted successfully',
      deletedProductId: productId,
      deletedProductName: product.name
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('[delete-merch] Error:', error);

    return ApiErrors.serverError('Failed to delete product');
  }
};
