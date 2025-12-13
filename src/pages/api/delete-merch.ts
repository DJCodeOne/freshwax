// src/pages/api/delete-merch.ts
// Delete a merch product - removes from Firebase and R2

import type { APIRoute } from 'astro';
import { S3Client, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDocument, deleteDocument, updateDocument, addDocument, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
};

const s3Client = new S3Client({
  region: 'auto',
  endpoint: 'https://' + R2_CONFIG.accountId + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const { productId } = await request.json();

    if (!productId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    log.info('[delete-merch] Deleting product:', productId);

    const product = await getDocument('merch', productId);

    if (!product) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Delete images from R2
    if (product.r2FolderPath) {
      log.info('[delete-merch] Deleting R2 folder:', product.r2FolderPath);

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
          log.info('[delete-merch] Deleted', listResult.Contents.length, 'files from R2');
        }
      } catch (r2Error) {
        log.error('[delete-merch] R2 deletion error:', r2Error);
      }
    }

    // Update supplier stats if applicable
    if (product.supplierId) {
      try {
        const supplierData = await getDocument('merch-suppliers', product.supplierId);
        if (supplierData) {
          await updateDocument('merch-suppliers', product.supplierId, {
            totalProducts: (supplierData.totalProducts || 0) - 1,
            totalStock: (supplierData.totalStock || 0) - (product.totalStock || 0),
            updatedAt: new Date().toISOString()
          });
          log.info('[delete-merch] Updated supplier stats');
        }
      } catch (e) {
        log.info('[delete-merch] Could not update supplier stats');
      }
    }

    // Log the deletion
    await addDocument('merch-stock-movements', {
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

    await deleteDocument('merch', productId);

    log.info('[delete-merch] Product deleted:', productId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Product deleted successfully',
      deletedProductId: productId,
      deletedProductName: product.name
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[delete-merch] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete product',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
