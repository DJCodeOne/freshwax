// src/pages/api/upload-merch.ts
// Comprehensive merch upload - Firebase for data, R2 for images
// Handles all product types with variant-level stock tracking

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const prerender = false;

// R2 Configuration
const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  publicDomain: import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
};

// Initialize Firebase
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

// Initialize R2 Client
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

// Product type definitions
const PRODUCT_TYPES = {
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

// Standard sizes for clothing
const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

// Generate SKU
function generateSKU(productType: string, supplierCode: string): string {
  const typeCode = productType.substring(0, 3).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `${typeCode}-${supplierCode}-${timestamp}`;
}

// Sanitize for folder names
function sanitizeForPath(str: string): string {
  return str.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
}

export const POST: APIRoute = async ({ request }) => {
  try {
    console.log('=== Merch Upload Started ===');
    
    const formData = await request.formData();
    
    // ============================================
    // PARSE FORM DATA
    // ============================================
    
    // Basic product info
    const productName = (formData.get('productName') as string || '').trim();
    const productType = (formData.get('productType') as string || '').trim();
    const description = (formData.get('description') as string || '').trim();
    const sku = (formData.get('sku') as string || '').trim();
    
    // Pricing
    const costPrice = parseFloat(formData.get('costPrice') as string || '0');
    const retailPrice = parseFloat(formData.get('retailPrice') as string || '0');
    const salePrice = parseFloat(formData.get('salePrice') as string || '0') || null;
    
    // Supplier info
    const supplierId = (formData.get('supplierId') as string || '').trim();
    const supplierName = (formData.get('supplierName') as string || '').trim();
    const supplierCode = (formData.get('supplierCode') as string || 'FW').trim().toUpperCase();
    const supplierCut = parseFloat(formData.get('supplierCut') as string || '0'); // Percentage
    
    // Category (label, dj, soundsystem, crew, freshwax)
    const category = (formData.get('category') as string || 'freshwax').trim();
    const categoryName = (formData.get('categoryName') as string || 'Fresh Wax').trim();
    
    // Stock settings
    const lowStockThreshold = parseInt(formData.get('lowStockThreshold') as string || '5');
    
    // Variants - sizes and colors with stock
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
      console.error('Error parsing variants JSON:', e);
    }
    
    // Images
    const imageCount = parseInt(formData.get('imageCount') as string || '0');
    
    console.log('Form data received:', {
      productName,
      productType,
      category,
      supplierId,
      supplierName,
      costPrice,
      retailPrice,
      sizesCount: sizes.length,
      colorsCount: colors.length,
      variantsCount: variants.length,
      imageCount
    });

    // ============================================
    // VALIDATION
    // ============================================
    
    if (!productName) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Product name is required' 
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    if (!productType || !PRODUCT_TYPES[productType as keyof typeof PRODUCT_TYPES]) {
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

    // ============================================
    // GENERATE IDs AND PATHS
    // ============================================
    
    const timestamp = Date.now();
    const productId = `merch_${sanitizeForPath(productType)}_${timestamp}`;
    const generatedSKU = sku || generateSKU(productType, supplierCode);
    const folderPath = `merch/${category}/${productId}`;
    
    console.log('Generated:', { productId, generatedSKU, folderPath });

    // ============================================
    // UPLOAD IMAGES TO R2
    // ============================================
    
    const uploadedImages: Array<{
      url: string;
      key: string;
      index: number;
      isPrimary: boolean;
    }> = [];
    
    for (let i = 0; i < imageCount; i++) {
      const imageFile = formData.get(`image_${i}`) as File;
      
      if (!imageFile || imageFile.size === 0) {
        console.log(`Skipping empty image slot ${i}`);
        continue;
      }
      
      console.log(`📤 Uploading image ${i + 1}/${imageCount}...`);
      
      const imageBuffer = await imageFile.arrayBuffer();
      const imageExt = imageFile.name.split('.').pop() || 'jpg';
      const imageKey = `${folderPath}/image_${i}.${imageExt}`;
      
      await s3Client.send(
        new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: imageKey,
          Body: Buffer.from(imageBuffer),
          ContentType: imageFile.type,
          CacheControl: 'public, max-age=31536000',
        })
      );
      
      const imageUrl = `${R2_CONFIG.publicDomain}/${imageKey}`;
      
      uploadedImages.push({
        url: imageUrl,
        key: imageKey,
        index: i,
        isPrimary: i === 0
      });
      
      console.log(`✓ Image ${i + 1} uploaded:`, imageUrl);
    }
    
    if (uploadedImages.length === 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Failed to upload any images' 
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // ============================================
    // BUILD VARIANT STOCK MAP
    // ============================================
    
    // Stock is tracked per variant (size+color combination)
    // For products without sizes/colors, we create a single "default" variant
    
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
    
    const productTypeConfig = PRODUCT_TYPES[productType as keyof typeof PRODUCT_TYPES];
    
    if (variants.length > 0) {
      // Use provided variants
      variants.forEach((v, idx) => {
        const variantKey = `${v.size || 'onesize'}_${v.color || 'default'}`.toLowerCase().replace(/\s/g, '-');
        const variantSKU = v.sku || `${generatedSKU}-${variantKey.toUpperCase()}`;
        
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
      // Generate variants from sizes × colors
      sizes.forEach(size => {
        if (colors.length > 0) {
          colors.forEach(color => {
            const variantKey = `${size}_${color.name}`.toLowerCase().replace(/\s/g, '-');
            variantStock[variantKey] = {
              sku: `${generatedSKU}-${size.toUpperCase()}-${color.name.substring(0, 3).toUpperCase()}`,
              size: size,
              color: color.name,
              colorHex: color.hex,
              stock: 0,
              reserved: 0,
              sold: 0
            };
          });
        } else {
          const variantKey = `${size}_default`.toLowerCase();
          variantStock[variantKey] = {
            sku: `${generatedSKU}-${size.toUpperCase()}`,
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
      // Colors only (no sizes)
      colors.forEach(color => {
        const variantKey = `onesize_${color.name}`.toLowerCase().replace(/\s/g, '-');
        variantStock[variantKey] = {
          sku: `${generatedSKU}-${color.name.substring(0, 3).toUpperCase()}`,
          size: null,
          color: color.name,
          colorHex: color.hex,
          stock: 0,
          reserved: 0,
          sold: 0
        };
      });
    } else {
      // No variants - single default
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

    // ============================================
    // BUILD PRODUCT DOCUMENT
    // ============================================
    
    const productData = {
      // Identifiers
      id: productId,
      sku: generatedSKU,
      
      // Product info
      name: productName,
      productType: productType,
      productTypeName: productTypeConfig.name,
      description: description,
      
      // Category
      category: category,
      categoryName: categoryName,
      
      // Pricing
      costPrice: costPrice,
      retailPrice: retailPrice,
      salePrice: salePrice,
      onSale: salePrice !== null && salePrice > 0 && salePrice < retailPrice,
      
      // Supplier/Consignment
      supplierId: supplierId || null,
      supplierName: supplierName || 'Fresh Wax',
      supplierCode: supplierCode,
      supplierCut: supplierCut, // Percentage they get per sale
      isConsignment: !!supplierId, // True if from external supplier
      
      // Images
      images: uploadedImages,
      primaryImage: uploadedImages[0]?.url || null,
      
      // Variant configuration
      hasSizes: productTypeConfig.hasSizes && sizes.length > 0,
      hasColors: colors.length > 0,
      sizes: sizes,
      colors: colors,
      
      // Stock (variant-level tracking)
      variantStock: variantStock,
      totalStock: totalStock,
      reservedStock: 0,
      soldStock: 0,
      
      // Stock alerts
      lowStockThreshold: lowStockThreshold,
      isLowStock: totalStock <= lowStockThreshold,
      isOutOfStock: totalStock === 0,
      
      // Status
      published: true,
      status: 'active',
      featured: false,
      
      // Storage info
      r2FolderPath: folderPath,
      storage: 'r2',
      
      // Timestamps
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      
      // Stats
      views: 0,
      sales: 0,
      revenue: 0,
    };

    // ============================================
    // SAVE TO FIREBASE
    // ============================================
    
    console.log('💾 Saving to Firebase merch collection...');
    
    await db.collection('merch').doc(productId).set(productData);
    
    console.log('✓ Product saved to Firebase');

    // ============================================
    // LOG STOCK MOVEMENT (Initial receipt)
    // ============================================
    
    if (totalStock > 0) {
      const movementId = `movement_${timestamp}`;
      await db.collection('merch-stock-movements').doc(movementId).set({
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
      
      console.log('✓ Stock movement logged');
    }

    // ============================================
    // UPDATE SUPPLIER STATS (if consignment)
    // ============================================
    
    if (supplierId) {
      try {
        await db.collection('merch-suppliers').doc(supplierId).update({
          totalProducts: FieldValue.increment(1),
          totalStock: FieldValue.increment(totalStock),
          updatedAt: new Date().toISOString()
        });
        console.log('✓ Supplier stats updated');
      } catch (e) {
        console.log('Note: Supplier document may not exist yet');
      }
    }

    console.log('=== Merch Upload Complete ===');
    console.log('Product ID:', productId);
    console.log('SKU:', generatedSKU);
    console.log('Total Stock:', totalStock);
    console.log('Variants:', Object.keys(variantStock).length);

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
    console.error('=== Merch Upload Error ===');
    console.error(error);
    
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