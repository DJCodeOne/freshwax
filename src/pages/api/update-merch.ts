// src/pages/api/update-merch.ts
// Update existing merch product details

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../../lib/s3-client';
import { getDocument, clearCache, clearAllMerchCache } from '../../lib/firebase-rest';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';
import { saUpdateDocument, saGetDocument } from '../../lib/firebase-service-account';
import { requireAdminAuth } from '../../lib/admin';
import { d1UpsertMerch } from '../../lib/d1-catalog';
import { processImageToSquareWebP, processImageToWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, getR2Config, successResponse } from '../../lib/api-utils';

// Zod schemas for JSON fields parsed from FormData
const FormDataSizesSchema = z.array(z.string().max(20)).max(20);
const FormDataColorsSchema = z.array(z.object({
  name: z.string().min(1).max(50),
  hex: z.string().max(10),
})).max(30);
const FormDataDeleteImagesSchema = z.array(z.number().int().min(0).max(100)).max(20);

// Max lengths for text fields from FormData
const TEXT_FIELD_MAX_LENGTHS: Record<string, number> = {
  name: 200,
  description: 2000,
  sku: 50,
  category: 100,
  categoryName: 100,
  brandAccountId: 200,
  supplierId: 200,
  supplierName: 200,
  supplierCode: 10,
};

const UpdateMerchJsonSchema = z.object({
  productId: z.string().min(1),
  images: z.array(z.unknown()).optional(),
  primaryImage: z.string().optional(),
  colors: z.array(z.unknown()).optional(),
  sizes: z.array(z.unknown()).optional(),
  variantStock: z.unknown().optional(),
  totalStock: z.union([z.number(), z.string()]).optional(),
  hasColors: z.boolean().optional(),
  hasSizes: z.boolean().optional(),
  retailPrice: z.union([z.number(), z.string()]).optional(),
  costPrice: z.union([z.number(), z.string()]).optional(),
  salePrice: z.union([z.number(), z.string(), z.null()]).optional(),
  onSale: z.boolean().optional(),
}).strip();

const log = createLogger('update-merch');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-merch:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = locals.runtime.env;
  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    const contentType = request.headers.get('content-type') || '';

    // Handle JSON body for image-only updates
    if (contentType.includes('application/json')) {
      const rawData = await request.json();
      const parseResult = UpdateMerchJsonSchema.safeParse(rawData);
      if (!parseResult.success) {
        return ApiErrors.badRequest('Invalid request data');
      }
      const data = parseResult.data;
      const { productId, images, primaryImage } = data;

      log.info('[update-merch] JSON update for product:', productId);

      const productDoc = await getDocument('merch', productId);

      if (!productDoc) {
        return ApiErrors.notFound('Product not found');
      }

      const updates: Record<string, unknown> = {
        updatedAt: new Date().toISOString()
      };

      if (images !== undefined) {
        updates.images = images;
      }

      if (primaryImage !== undefined) {
        updates.primaryImage = primaryImage;
        updates.imageUrl = primaryImage; // Keep legacy field in sync
      }

      // Colors and sizes support
      if (data.colors !== undefined) {
        updates.colors = data.colors;
      }

      if (data.sizes !== undefined) {
        updates.sizes = data.sizes;
      }

      if (data.variantStock !== undefined) {
        updates.variantStock = data.variantStock;
      }

      if (data.totalStock !== undefined) {
        // Ensure totalStock is always a valid number
        const numericStock = typeof data.totalStock === 'number' ? data.totalStock : parseInt(data.totalStock, 10);
        updates.totalStock = Number.isFinite(numericStock) ? numericStock : 0;
        updates.stock = updates.totalStock; // Keep legacy field in sync
      }

      if (data.hasColors !== undefined) {
        updates.hasColors = data.hasColors;
      }

      if (data.hasSizes !== undefined) {
        updates.hasSizes = data.hasSizes;
      }

      // Price updates
      if (data.retailPrice !== undefined) {
        updates.retailPrice = parseFloat(data.retailPrice) || 0;
      }

      if (data.costPrice !== undefined) {
        updates.costPrice = parseFloat(data.costPrice) || 0;
      }

      if (data.salePrice !== undefined) {
        updates.salePrice = data.salePrice ? parseFloat(data.salePrice) : null;
      }

      if (data.onSale !== undefined) {
        updates.onSale = !!data.onSale;
      }

      // Use service account for authorized write
      const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

      // Try full JSON first, then construct from individual env vars
      let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY || import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

      if (!serviceAccountKey) {
        // Construct from individual env vars
        const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

        if (clientEmail && privateKey) {
          serviceAccountKey = JSON.stringify({
            type: 'service_account',
            project_id: projectId,
            private_key_id: 'auto',
            private_key: privateKey.replace(/\\n/g, '\n'),
            client_email: clientEmail,
            client_id: '',
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token'
          });
        }
      }

      if (!serviceAccountKey) {
        throw new Error('Firebase service account not configured (need FIREBASE_SERVICE_ACCOUNT or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)');
      }

      await saUpdateDocument(serviceAccountKey, projectId, 'merch', productId, updates);

      // Clear document cache to ensure we get fresh data from Firebase
      clearCache(`doc:merch:${productId}`);

      // Dual-write to D1 (secondary, non-blocking)
      const db = env?.DB;
      if (db) {
        try {
          const updatedProduct = await getDocument('merch', productId);
          if (updatedProduct) {
            await d1UpsertMerch(db, productId, updatedProduct);
            log.info('[update-merch] Images also updated in D1');
          }
        } catch (d1Error: unknown) {
          log.error('[update-merch] D1 dual-write failed (non-critical):', d1Error);
        }
      }

      log.info('[update-merch] Images updated for:', productId);

      // Clear all merch caches to ensure fresh data on next page load
      clearAllMerchCache();
      await kvDelete('live-merch-v2:all', CACHE_CONFIG.MERCH).catch(() => { /* KV cache invalidation — non-critical */ });

      return successResponse({ message: 'Images updated successfully' });
    }

    // Handle FormData for full updates
    const formData = await request.formData();

    const productId = formData.get('productId') as string;

    if (!productId) {
      return ApiErrors.badRequest('Product ID is required');
    }

    log.info('[update-merch] Updating product:', productId);

    const existingProduct = await getDocument('merch', productId);

    if (!existingProduct) {
      return ApiErrors.notFound('Product not found');
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString()
    };

    const textFields = [
      'name', 'description', 'sku', 'category', 'categoryName',
      'brandAccountId', 'supplierId', 'supplierName', 'supplierCode'
    ];

    textFields.forEach(field => {
      const value = formData.get(field);
      if (value !== null) {
        const maxLen = TEXT_FIELD_MAX_LENGTHS[field] || 200;
        updates[field] = (value as string).trim().slice(0, maxLen);
      }
    });

    const numberFields = [
      'costPrice', 'retailPrice', 'salePrice', 'supplierCut', 'lowStockThreshold'
    ];

    numberFields.forEach(field => {
      const value = formData.get(field);
      if (value !== null && value !== '') {
        const num = parseFloat(value as string);
        if (!Number.isFinite(num) || num < 0 || num > 99999) {
          return; // skip invalid numbers silently — field is optional
        }
        updates[field] = num;
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
      let sizesRaw: unknown;
      try {
        sizesRaw = JSON.parse(sizesJson as string);
      } catch (_e: unknown) {
        return ApiErrors.badRequest('Invalid sizes format');
      }
      const sizesResult = FormDataSizesSchema.safeParse(sizesRaw);
      if (!sizesResult.success) {
        return ApiErrors.badRequest('Invalid sizes: ' + sizesResult.error.errors[0]?.message);
      }
      updates.sizes = sizesResult.data;
      updates.hasSizes = sizesResult.data.length > 0;
    }

    const colorsJson = formData.get('colors');
    if (colorsJson) {
      let colorsRaw: unknown;
      try {
        colorsRaw = JSON.parse(colorsJson as string);
      } catch (_e: unknown) {
        return ApiErrors.badRequest('Invalid colors format');
      }
      const colorsResult = FormDataColorsSchema.safeParse(colorsRaw);
      if (!colorsResult.success) {
        return ApiErrors.badRequest('Invalid colors: ' + colorsResult.error.errors[0]?.message);
      }
      updates.colors = colorsResult.data;
      updates.hasColors = colorsResult.data.length > 0;
    }

    const newImageCount = parseInt(formData.get('newImageCount') as string || '0');
    const deleteImageIndexes = formData.get('deleteImages');

    let images = [...(existingProduct.images || [])];

    if (deleteImageIndexes) {
      let deleteRaw: unknown;
      try {
        deleteRaw = JSON.parse(deleteImageIndexes as string);
      } catch (_e: unknown) {
        return ApiErrors.badRequest('Invalid deleteImages format');
      }
      const deleteResult = FormDataDeleteImagesSchema.safeParse(deleteRaw);
      if (!deleteResult.success) {
        return ApiErrors.badRequest('Invalid deleteImages: ' + deleteResult.error.errors[0]?.message);
      }
      const indexesToDelete = deleteResult.data;

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
          } catch (e: unknown) {
            log.error('[update-merch] Failed to delete image from R2');
          }
        }
      }

      indexesToDelete.sort((a, b) => b - a).forEach(idx => {
        images.splice(idx, 1);
      });
    }

    if (newImageCount > 0) {
      const folderPath = existingProduct.r2FolderPath;
      const startIndex = images.length;

      for (let i = 0; i < newImageCount; i++) {
        const imageFile = formData.get('newImage_' + i) as File;

        if (!imageFile || imageFile.size === 0) continue;

        log.info('[update-merch] Uploading new image', i + 1);

        const imageBuffer = await imageFile.arrayBuffer();

        let imageKey: string;
        let uploadBody: Uint8Array | Buffer;
        let uploadContentType: string;

        try {
          const processed = await processImageToSquareWebP(imageBuffer, 800, 85);
          imageKey = folderPath + '/image_' + (startIndex + i) + '_' + Date.now() + imageExtension(processed.format);
          uploadBody = processed.buffer;
          uploadContentType = imageContentType(processed.format);
          log.info('[update-merch] Converted to', processed.format + ':', processed.width, 'x', processed.height);
        } catch (imgErr: unknown) {
          log.warn('[update-merch] WebP conversion failed, uploading original:', imgErr);
          const imageExt = imageFile.name.split('.').pop() || 'jpg';
          imageKey = folderPath + '/image_' + (startIndex + i) + '_' + Date.now() + '.' + imageExt;
          uploadBody = Buffer.from(imageBuffer);
          uploadContentType = imageFile.type;
        }

        await s3Client.send(
          new PutObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: imageKey,
            Body: uploadBody,
            ContentType: uploadContentType,
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

    // Use service account for authorized write
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    // Try full JSON first, then construct from individual env vars
    let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY || import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (!serviceAccountKey) {
      // Construct from individual env vars
      const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

      if (clientEmail && privateKey) {
        serviceAccountKey = JSON.stringify({
          type: 'service_account',
          project_id: projectId,
          private_key_id: 'auto',
          private_key: privateKey.replace(/\\n/g, '\n'),
          client_email: clientEmail,
          client_id: '',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token'
        });
      }
    }

    if (!serviceAccountKey) {
      throw new Error('Firebase service account not configured (need FIREBASE_SERVICE_ACCOUNT or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)');
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'merch', productId, updates);

    // Clear document cache to ensure we get fresh data from Firebase
    clearCache(`doc:merch:${productId}`);

    const updatedDoc = await getDocument('merch', productId);
    const updatedProduct = { id: productId, ...updatedDoc };

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db && updatedDoc) {
      try {
        await d1UpsertMerch(db, productId, updatedDoc);
        log.info('[update-merch] Also updated in D1');
      } catch (d1Error: unknown) {
        log.error('[update-merch] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    log.info('[update-merch] Product updated:', productId);

    // Clear all merch caches to ensure fresh data on next page load
    clearAllMerchCache();
    await kvDelete('live-merch-v2:all', CACHE_CONFIG.MERCH).catch(() => { /* KV cache invalidation — non-critical */ });

    return successResponse({ message: 'Product updated successfully',
      product: updatedProduct });

  } catch (error: unknown) {
    log.error('[update-merch] Error:', error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return ApiErrors.serverError('Failed to update product');
  }
};
