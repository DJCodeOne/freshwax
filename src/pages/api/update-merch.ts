// src/pages/api/update-merch.ts
// Update existing merch product details

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  publicDomain: import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
};

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = getFirestore();

const s3Client = new S3Client({
  region: 'auto',
  endpoint: 'https://' + R2_CONFIG.accountId + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    
    const productId = formData.get('productId') as string;
    
    if (!productId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    log.info('[update-merch] Updating product:', productId);
    
    const productRef = db.collection('merch').doc(productId);
    const productDoc = await productRef.get();
    
    if (!productDoc.exists) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Product not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    const existingProduct = productDoc.data()!;
    
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
    
    await productRef.update(updates);
    
    const updatedDoc = await productRef.get();
    const updatedProduct = { id: updatedDoc.id, ...updatedDoc.data() };
    
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