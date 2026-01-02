// src/pages/api/upload-merch.ts
// Comprehensive merch upload - Firebase for data, R2 for images
// Images auto-processed to 800x800 WebP
// Uses WASM-based image processing for Cloudflare Workers compatibility

import '../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { setDocument, updateDocument, getDocument, addDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { processImageToSquareWebP } from '../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { requireAdminAuth } from '../../lib/admin';

// Image processing settings
const IMAGE_SIZE = 800;
const WEBP_QUALITY = 85;

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

const PRODUCT_TYPES: Record<string, { name: string; hasSizes: boolean; hasColors: boolean }> = {
  'tshirt': { name: 'T-Shirt', hasSizes: true, hasColors: true },
  'hoodie': { name: 'Hoodie', hasSizes: true, hasColors: true },
  'cap': { name: 'Cap', hasSizes: false, hasColors: true },
  'ashtray': { name: 'Ashtray', hasSizes: false, hasColors: true },
  'grinder': { name: 'Grinder', hasSizes: false, hasColors: true },
  'mug': { name: 'Mug', hasSizes: false, hasColors: true },
  'keyring': { name: 'Keyring', hasSizes: false, hasColors: true },
  'sticker': { name: 'Sticker', hasSizes: false, hasColors: false },
  'other': { name: 'Other', hasSizes: false, hasColors: true },
};

function generateSKU(productType: string, supplierCode: string): string {
  const typeCode = productType.substring(0, 3).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase();
  return typeCode + '-' + supplierCode + '-' + timestamp;
}

function sanitizeForPath(str: string): string {
  return str.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`upload-merch:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;
  initFirebase(locals);

  const r2Config = getR2Config(env);
  const s3Client = createS3Client(r2Config);

  try {
    log.info('[upload-merch] Started');

    const formData = await request.formData();

    const productName = (formData.get('productName') as string || '').trim();
    const productType = (formData.get('productType') as string || '').trim();
    const description = (formData.get('description') as string || '').trim();
    const sku = (formData.get('sku') as string || '').trim();

    const costPrice = parseFloat(formData.get('costPrice') as string || '0');
    const retailPrice = parseFloat(formData.get('retailPrice') as string || '0');
    const salePrice = parseFloat(formData.get('salePrice') as string || '0') || null;

    const supplierId = (formData.get('supplierId') as string || '').trim();
    const supplierName = (formData.get('supplierName') as string || '').trim();
    const supplierCode = (formData.get('supplierCode') as string || 'FW').trim().toUpperCase();
    const supplierCut = parseFloat(formData.get('supplierCut') as string || '0');

    const category = (formData.get('category') as string || 'freshwax').trim();
    const categoryName = (formData.get('categoryName') as string || 'Fresh Wax').trim();

    const lowStockThreshold = parseInt(formData.get('lowStockThreshold') as string || '5');

    const sizesJson = formData.get('sizes') as string || '[]';
    const colorsJson = formData.get('colors') as string || '[]';
    const variantsJson = formData.get('variants') as string || '[]';

    let sizes: string[] = [];
    let colors: Array<{name: string, hex: string}> = [];
    let variants: Array<{size?: string, color?: string, colorHex?: string, stock: number, sku?: string}> = [];

    try {
      sizes = JSON.parse(sizesJson);
      colors = JSON.parse(colorsJson);
      variants = JSON.parse(variantsJson);
    } catch (e) {
      log.error('Error parsing variants JSON');
    }

    const imageCount = parseInt(formData.get('imageCount') as string || '0');

    log.info('[upload-merch] Product:', productName, productType);

    if (!productName) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product name is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!productType || !PRODUCT_TYPES[productType]) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Valid product type is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (retailPrice <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Retail price must be greater than 0'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (imageCount === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'At least one product image is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const timestamp = Date.now();
    const productId = 'merch_' + sanitizeForPath(productType) + '_' + timestamp;
    const generatedSKU = sku || generateSKU(productType, supplierCode);
    const folderPath = 'merch/' + category + '/' + productId;

    log.info('[upload-merch] ID:', productId, 'SKU:', generatedSKU);

    // Parse image-color mappings
    let imageColorMap: Array<{index: number; color: string | null; colorHex: string | null}> = [];
    try {
      const mapJson = formData.get('imageColorMap') as string;
      if (mapJson) {
        imageColorMap = JSON.parse(mapJson);
      }
    } catch (e) {
      log.info('[upload-merch] No image color map provided');
    }

    const uploadedImages: Array<{
      url: string;
      key: string;
      index: number;
      isPrimary: boolean;
      color: string | null;
      colorHex: string | null;
    }> = [];

    for (let i = 0; i < imageCount; i++) {
      const imageFile = formData.get('image_' + i) as File;

      if (!imageFile || imageFile.size === 0) {
        continue;
      }

      log.info('[upload-merch] Processing image', i + 1);

      const inputBuffer = await imageFile.arrayBuffer();
      const originalSize = inputBuffer.byteLength;

      // Process image: crop to square, resize to 800x800, convert to WebP
      const processed = await processImageToSquareWebP(inputBuffer, IMAGE_SIZE, WEBP_QUALITY);

      // Always save as .webp
      const imageKey = folderPath + '/image_' + i + '.webp';

      await s3Client.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: imageKey,
          Body: processed.buffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000',
        })
      );

      const imageUrl = r2Config.publicDomain + '/' + imageKey;

      // Find color mapping for this image
      const colorMapping = imageColorMap.find(m => m.index === i);

      uploadedImages.push({
        url: imageUrl,
        key: imageKey,
        index: i,
        isPrimary: i === 0,
        color: colorMapping?.color || null,
        colorHex: colorMapping?.colorHex || null
      });

      log.info('[upload-merch] Image processed and uploaded:', imageUrl,
        `(${(originalSize/1024).toFixed(1)}KB → ${(processed.buffer.length/1024).toFixed(1)}KB)`,
        colorMapping?.color ? `[Color: ${colorMapping.color}]` : '');
    }

    if (uploadedImages.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to upload any images'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const variantStock: Record<string, {
      sku: string;
      size: string | null;
      color: string | null;
      colorHex: string | null;
      stock: number;
      reserved: number;
      sold: number;
    }> = {};

    let totalStock = 0;

    const productTypeConfig = PRODUCT_TYPES[productType];

    if (variants.length > 0) {
      variants.forEach((v) => {
        const variantKey = ((v.size || 'onesize') + '_' + (v.color || 'default')).toLowerCase().replace(/\s/g, '-');
        const variantSKU = v.sku || (generatedSKU + '-' + variantKey.toUpperCase());

        variantStock[variantKey] = {
          sku: variantSKU,
          size: v.size || null,
          color: v.color || null,
          colorHex: v.colorHex || null,
          stock: v.stock || 0,
          reserved: 0,
          sold: 0
        };

        totalStock += v.stock || 0;
      });
    } else if (productTypeConfig.hasSizes && sizes.length > 0) {
      sizes.forEach(size => {
        if (colors.length > 0) {
          colors.forEach(color => {
            const variantKey = (size + '_' + color.name).toLowerCase().replace(/\s/g, '-');
            variantStock[variantKey] = {
              sku: generatedSKU + '-' + size.toUpperCase() + '-' + color.name.substring(0, 3).toUpperCase(),
              size: size,
              color: color.name,
              colorHex: color.hex,
              stock: 0,
              reserved: 0,
              sold: 0
            };
          });
        } else {
          const variantKey = (size + '_default').toLowerCase();
          variantStock[variantKey] = {
            sku: generatedSKU + '-' + size.toUpperCase(),
            size: size,
            color: null,
            colorHex: null,
            stock: 0,
            reserved: 0,
            sold: 0
          };
        }
      });
    } else if (colors.length > 0) {
      colors.forEach(color => {
        const variantKey = ('onesize_' + color.name).toLowerCase().replace(/\s/g, '-');
        variantStock[variantKey] = {
          sku: generatedSKU + '-' + color.name.substring(0, 3).toUpperCase(),
          size: null,
          color: color.name,
          colorHex: color.hex,
          stock: 0,
          reserved: 0,
          sold: 0
        };
      });
    } else {
      variantStock['default'] = {
        sku: generatedSKU,
        size: null,
        color: null,
        colorHex: null,
        stock: 0,
        reserved: 0,
        sold: 0
      };
    }

    const productData = {
      id: productId,
      sku: generatedSKU,
      name: productName,
      productType: productType,
      productTypeName: productTypeConfig.name,
      description: description,
      category: category,
      categoryName: categoryName,
      costPrice: costPrice,
      retailPrice: retailPrice,
      salePrice: salePrice,
      onSale: salePrice !== null && salePrice > 0 && salePrice < retailPrice,
      supplierId: supplierId || null,
      supplierName: supplierName || 'Fresh Wax',
      supplierCode: supplierCode,
      supplierCut: supplierCut,
      isConsignment: !!supplierId,
      images: uploadedImages,
      primaryImage: uploadedImages[0]?.url || null,
      hasSizes: productTypeConfig.hasSizes && sizes.length > 0,
      hasColors: colors.length > 0,
      sizes: sizes,
      colors: colors,
      variantStock: variantStock,
      totalStock: totalStock,
      reservedStock: 0,
      soldStock: 0,
      lowStockThreshold: lowStockThreshold,
      isLowStock: totalStock <= lowStockThreshold,
      isOutOfStock: totalStock === 0,
      published: true,
      status: 'active',
      featured: false,
      r2FolderPath: folderPath,
      storage: 'r2',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      views: 0,
      sales: 0,
      revenue: 0,
    };

    log.info('[upload-merch] Saving to Firebase');

    await setDocument('merch', productId, productData);

    log.info('[upload-merch] Product saved');

    if (totalStock > 0) {
      const movementId = 'movement_' + timestamp;
      await setDocument('merch-stock-movements', movementId, {
        id: movementId,
        productId: productId,
        productName: productName,
        sku: generatedSKU,
        type: 'received',
        quantity: totalStock,
        previousStock: 0,
        newStock: totalStock,
        supplierId: supplierId || null,
        supplierName: supplierName || 'Fresh Wax',
        notes: 'Initial stock receipt',
        createdAt: new Date().toISOString(),
        createdBy: 'admin'
      });

      log.info('[upload-merch] Stock movement logged');
    }

    if (supplierId) {
      try {
        const supplierData = await getDocument('merch-suppliers', supplierId);
        if (supplierData) {
          await updateDocument('merch-suppliers', supplierId, {
            totalProducts: (supplierData.totalProducts || 0) + 1,
            totalStock: (supplierData.totalStock || 0) + totalStock,
            updatedAt: new Date().toISOString()
          });
          log.info('[upload-merch] Supplier stats updated');
        }
      } catch (e) {
        log.info('Note: Supplier document may not exist yet');
      }
    }

    log.info('[upload-merch] Complete:', productId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Product uploaded successfully',
      productId: productId,
      sku: generatedSKU,
      product: productData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[upload-merch] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to upload product',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
