// src/pages/api/update-merch.ts
// Update existing merch product details

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { requireAdminAuth } from '../../lib/admin';

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

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

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
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebase(locals);

  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    const contentType = request.headers.get('content-type') || '';

    // Handle JSON body for image-only updates
    if (contentType.includes('application/json')) {
      const data = await request.json();
      const { productId, images, primaryImage } = data;

      if (!productId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Product ID is required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      log.info('[update-merch] JSON update for product:', productId);

      const productDoc = await getDocument('merch', productId);

      if (!productDoc) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Product not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      const updates: any = {
        updatedAt: new Date().toISOString()
      };

      if (images !== undefined) {
        updates.images = images;
      }

      if (primaryImage !== undefined) {
        updates.primaryImage = primaryImage;
        updates.imageUrl = primaryImage; // Keep legacy field in sync
      }

      await updateDocument('merch', productId, updates);

      log.info('[update-merch] Images updated for:', productId);

      return new Response(JSON.stringify({
        success: true,
        message: 'Images updated successfully'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle FormData for full updates
    const formData = await request.formData();

    const productId = formData.get('productId') as string;

    if (!productId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    log.info('[update-merch] Updating product:', productId);

    const existingProduct = await getDocument('merch', productId);

    if (!existingProduct) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const updates: any = {
      updatedAt: new Date().toISOString()
    };

    const textFields = [
      'name', 'description', 'sku', 'category', 'categoryName',
      'supplierId', 'supplierName', 'supplierCode'
    ];

    textFields.forEach(field => {
      const value = formData.get(field);
      if (value !== null) {
        updates[field] = (value as string).trim();
      }
    });

    const numberFields = [
      'costPrice', 'retailPrice', 'salePrice', 'supplierCut', 'lowStockThreshold'
    ];

    numberFields.forEach(field => {
      const value = formData.get(field);
      if (value !== null && value !== '') {
        updates[field] = parseFloat(value as string);
      }
    });

    const booleanFields = ['published', 'featured', 'onSale'];

    booleanFields.forEach(field => {
      const value = formData.get(field);
      if (value !== null) {
        updates[field] = value === 'true';
      }
    });

    if (updates.salePrice !== undefined && updates.retailPrice !== undefined) {
      updates.onSale = updates.salePrice > 0 && updates.salePrice < updates.retailPrice;
    } else if (updates.salePrice !== undefined) {
      updates.onSale = updates.salePrice > 0 && updates.salePrice < existingProduct.retailPrice;
    }

    const sizesJson = formData.get('sizes');
    if (sizesJson) {
      try {
        updates.sizes = JSON.parse(sizesJson as string);
        updates.hasSizes = updates.sizes.length > 0;
      } catch (e) {
        log.error('Error parsing sizes JSON');
      }
    }

    const colorsJson = formData.get('colors');
    if (colorsJson) {
      try {
        updates.colors = JSON.parse(colorsJson as string);
        updates.hasColors = updates.colors.length > 0;
      } catch (e) {
        log.error('Error parsing colors JSON');
      }
    }

    const newImageCount = parseInt(formData.get('newImageCount') as string || '0');
    const deleteImageIndexes = formData.get('deleteImages');

    let images = [...(existingProduct.images || [])];

    if (deleteImageIndexes) {
      try {
        const indexesToDelete = JSON.parse(deleteImageIndexes as string) as number[];

        for (const idx of indexesToDelete) {
          const imageToDelete = images[idx];
          if (imageToDelete && imageToDelete.key) {
            try {
              await s3Client.send(
                new DeleteObjectCommand({
                  Bucket: R2_CONFIG.bucketName,
                  Key: imageToDelete.key
                })
              );
              log.info('[update-merch] Deleted image:', imageToDelete.key);
            } catch (e) {
              log.error('[update-merch] Failed to delete image from R2');
            }
          }
        }

        indexesToDelete.sort((a, b) => b - a).forEach(idx => {
          images.splice(idx, 1);
        });
      } catch (e) {
        log.error('Error parsing deleteImages');
      }
    }

    if (newImageCount > 0) {
      const folderPath = existingProduct.r2FolderPath;
      const startIndex = images.length;

      for (let i = 0; i < newImageCount; i++) {
        const imageFile = formData.get('newImage_' + i) as File;

        if (!imageFile || imageFile.size === 0) continue;

        log.info('[update-merch] Uploading new image', i + 1);

        const imageBuffer = await imageFile.arrayBuffer();
        const imageExt = imageFile.name.split('.').pop() || 'jpg';
        const imageKey = folderPath + '/image_' + (startIndex + i) + '_' + Date.now() + '.' + imageExt;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: imageKey,
            Body: Buffer.from(imageBuffer),
            ContentType: imageFile.type,
            CacheControl: 'public, max-age=31536000',
          })
        );

        const imageUrl = R2_CONFIG.publicDomain + '/' + imageKey;

        images.push({
          url: imageUrl,
          key: imageKey,
          index: startIndex + i,
          isPrimary: images.length === 0
        });

        log.info('[update-merch] Uploaded:', imageUrl);
      }
    }

    if (images.length > 0) {
      images = images.map((img, idx) => ({
        ...img,
        index: idx,
        isPrimary: idx === 0
      }));

      updates.images = images;
      updates.primaryImage = images[0]?.url || null;
    }

    if (updates.lowStockThreshold !== undefined) {
      const currentStock = existingProduct.totalStock || 0;
      updates.isLowStock = currentStock <= updates.lowStockThreshold && currentStock > 0;
    }

    await updateDocument('merch', productId, updates);

    const updatedDoc = await getDocument('merch', productId);
    const updatedProduct = { id: productId, ...updatedDoc };

    log.info('[update-merch] Product updated:', productId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Product updated successfully',
      product: updatedProduct
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[update-merch] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update product',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
