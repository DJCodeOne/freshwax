// index.ts - Main entry point for merch processor Worker
// Processes merch product uploads: product images

import type { Env, MerchSubmissionMetadata, ProcessedMerch } from './types';
import { processProductImages } from './image-processor';
import { createMerchInFirebase } from './firebase';
import { sendProcessingCompleteEmail, sendProcessingFailedEmail } from './email';

/**
 * Generate a unique product ID from name and timestamp
 */
function generateProductId(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 40);
  const timestamp = Date.now();
  return `${sanitized}-${timestamp}`;
}

/**
 * Generate URL-friendly slug from product name
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 60);
}

/**
 * Parse submission from R2 bucket (merch-submissions/ folder)
 */
async function parseSubmission(
  submissionId: string,
  env: Env
): Promise<{ metadata: MerchSubmissionMetadata; imageKeys: string[] }> {
  console.log(`[Parser] Parsing submission: ${submissionId}`);

  // Get metadata.json from merch-submissions/ folder
  const metadataKey = `merch-submissions/${submissionId}/metadata.json`;
  const metadataObj = await env.MERCH_BUCKET.get(metadataKey);

  if (!metadataObj) {
    throw new Error(`Metadata not found: ${metadataKey}`);
  }

  const metadata: MerchSubmissionMetadata = await metadataObj.json();
  console.log(`[Parser] Metadata loaded: ${metadata.name} (${metadata.category})`);

  // List all files in submission folder
  const list = await env.MERCH_BUCKET.list({ prefix: `merch-submissions/${submissionId}/` });

  const imageKeys: string[] = [];

  for (const object of list.objects) {
    const key = object.key;
    const lowerKey = key.toLowerCase();

    // Skip metadata.json
    if (lowerKey.endsWith('metadata.json')) continue;

    // Detect images
    if (lowerKey.endsWith('.jpg') || lowerKey.endsWith('.jpeg') ||
        lowerKey.endsWith('.png') || lowerKey.endsWith('.webp') ||
        lowerKey.endsWith('.gif')) {
      imageKeys.push(key);
      console.log(`[Parser] Found image: ${key}`);
    }
  }

  // Sort images by filename to maintain order
  imageKeys.sort();

  console.log(`[Parser] Found ${imageKeys.length} images`);

  return { metadata, imageKeys };
}

/**
 * Process a merch submission
 */
async function processSubmission(
  submissionId: string,
  env: Env
): Promise<ProcessedMerch> {
  const { metadata, imageKeys } = await parseSubmission(submissionId, env);
  const productId = generateProductId(metadata.name);
  const slug = generateSlug(metadata.name);

  console.log(`[Processor] Starting: ${productId}`);
  console.log(`[Processor] Supplier: ${metadata.supplierName}`);
  console.log(`[Processor] Product: ${metadata.name}`);

  // Process images
  const { images, mainImage, thumbnail } = await processProductImages(
    submissionId,
    imageKeys,
    productId,
    env
  );

  const now = new Date().toISOString();
  const folderPath = `merch/${productId}`;

  return {
    id: productId,
    name: metadata.name,
    title: metadata.title || metadata.name,
    slug,
    description: metadata.description || '',

    // Supplier
    supplierName: metadata.supplierName,
    supplierId: metadata.supplierId,
    userId: metadata.userId,
    email: metadata.email,

    // Category
    category: metadata.category,
    subcategory: metadata.subcategory,

    // Pricing
    price: metadata.price,
    compareAtPrice: metadata.compareAtPrice,
    costPrice: metadata.costPrice,

    // Images
    images,
    imageUrl: mainImage,
    thumbnailUrl: thumbnail,

    // Inventory
    stock: metadata.stock || 0,
    sku: metadata.sku,
    barcode: metadata.barcode,
    trackInventory: metadata.trackInventory !== false,
    inStock: (metadata.stock || 0) > 0,

    // Variants
    hasVariants: metadata.hasVariants || false,
    variants: metadata.variants || [],

    // Attributes
    sizes: metadata.sizes,
    colors: metadata.colors,
    material: metadata.material,
    weight: metadata.weight,
    dimensions: metadata.dimensions,

    // Settings
    published: metadata.published !== false,
    featured: metadata.featured || false,
    approved: true,

    // Shipping
    requiresShipping: metadata.requiresShipping !== false,
    shippingWeight: metadata.shippingWeight,

    // SEO
    tags: metadata.tags || [],

    // Stats
    views: 0,
    sales: 0,

    // Status
    status: 'active',
    storage: 'r2',

    // Timestamps
    createdAt: now,
    updatedAt: now,

    // R2 metadata
    folder_path: folderPath
  };
}

/**
 * Delete submission files from bucket
 */
async function deleteSubmission(submissionId: string, env: Env): Promise<void> {
  console.log(`[Cleanup] Deleting: ${submissionId}`);

  const list = await env.MERCH_BUCKET.list({ prefix: `merch-submissions/${submissionId}/` });

  for (const object of list.objects) {
    await env.MERCH_BUCKET.delete(object.key);
  }

  console.log(`[Cleanup] Deleted ${list.objects.length} files`);
}

/**
 * List all pending submissions
 */
async function listSubmissions(env: Env): Promise<string[]> {
  const list = await env.MERCH_BUCKET.list({ prefix: 'merch-submissions/' });
  const submissions = new Set<string>();

  for (const object of list.objects) {
    const parts = object.key.split('/');
    if (parts.length >= 3 && parts[0] === 'merch-submissions') {
      submissions.add(parts[1]);
    }
  }

  return Array.from(submissions);
}

// =============================================================================
// WORKER EXPORT
// =============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'merch-processor',
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // List pending submissions
    if (url.pathname === '/submissions' && request.method === 'GET') {
      try {
        const submissions = await listSubmissions(env);
        return new Response(JSON.stringify({ submissions }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Process a submission
    if (url.pathname === '/process' && request.method === 'POST') {
      let submissionId = '';

      try {
        const body = await request.json() as { submissionId: string };
        submissionId = body.submissionId;

        if (!submissionId) {
          return new Response(JSON.stringify({ error: 'submissionId required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        console.log(`[API] Processing merch submission: ${submissionId}`);

        // Process the submission
        const product = await processSubmission(submissionId, env);

        // Save to Firebase
        await createMerchInFirebase(product, env);

        // Send success email
        await sendProcessingCompleteEmail(product, env);

        // Delete original files
        await deleteSubmission(submissionId, env);

        console.log(`[API] Complete: ${product.id}`);

        return new Response(JSON.stringify({
          success: true,
          productId: product.id,
          name: product.name,
          category: product.category,
          price: product.price,
          images: product.images.length,
          imageUrl: product.imageUrl
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

      } catch (error) {
        console.error('[API] Processing failed:', error);

        // Send failure email
        if (submissionId) {
          await sendProcessingFailedEmail(
            submissionId,
            error instanceof Error ? error.message : 'Unknown error',
            env
          ).catch(e => console.error('Failed to send error email:', e));
        }

        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Default response
    return new Response(JSON.stringify({
      service: 'Fresh Wax Merch Processor',
      endpoints: {
        'GET /health': 'Health check',
        'GET /submissions': 'List pending submissions',
        'POST /process': 'Process a submission { submissionId: string }'
      }
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};
