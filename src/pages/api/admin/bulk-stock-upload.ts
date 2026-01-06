// src/pages/api/admin/bulk-stock-upload.ts
// Bulk stock upload via CSV

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, addDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

interface StockUpdate {
  sku: string;
  productId?: string;
  variantKey?: string;
  quantity: number;
  operation: 'set' | 'add' | 'subtract';
}

interface BulkResult {
  success: number;
  failed: number;
  errors: string[];
  updates: { sku: string; oldStock: number; newStock: number }[];
}

// Parse CSV content
function parseCSV(content: string): { headers: string[], rows: string[][] } {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('CSV must have header row and at least one data row');
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = lines.slice(1).map(line => {
    // Handle quoted values with commas
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  });

  return { headers, rows };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;

  // Parse form data
  const formData = await request.formData();
  const csvFile = formData.get('csv') as File | null;
  const adminKey = formData.get('adminKey') as string;
  const operation = (formData.get('operation') as string) || 'set';

  // Admin auth check
  const ADMIN_KEY = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  if (!adminKey || adminKey !== ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!csvFile) {
    return new Response(JSON.stringify({ error: 'No CSV file provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const csvContent = await csvFile.text();
    const { headers, rows } = parseCSV(csvContent);

    // Validate required columns
    const skuIndex = headers.indexOf('sku');
    const quantityIndex = headers.indexOf('quantity');

    if (skuIndex === -1) {
      return new Response(JSON.stringify({
        error: 'CSV must have "sku" column'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (quantityIndex === -1) {
      return new Response(JSON.stringify({
        error: 'CSV must have "quantity" column'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Optional columns
    const operationIndex = headers.indexOf('operation');
    const productIdIndex = headers.indexOf('product_id');

    const result: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      updates: []
    };

    // Build SKU lookup cache
    const allMerch = await queryCollection('merch', { limit: 500 });
    const skuToProduct: Record<string, { productId: string; variantKey?: string; product: any }> = {};

    for (const product of allMerch) {
      // Main product SKU
      if (product.sku) {
        skuToProduct[product.sku.toUpperCase()] = { productId: product.id, product };
      }

      // Variant SKUs
      if (product.variantStock) {
        for (const [variantKey, variant] of Object.entries(product.variantStock as Record<string, any>)) {
          if (variant.sku) {
            skuToProduct[variant.sku.toUpperCase()] = {
              productId: product.id,
              variantKey,
              product
            };
          }
        }
      }
    }

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // Account for header row and 0-indexing

      try {
        const sku = row[skuIndex]?.trim().toUpperCase();
        const quantity = parseInt(row[quantityIndex]?.trim() || '0', 10);
        const rowOperation = operationIndex !== -1 ? row[operationIndex]?.trim().toLowerCase() : operation;
        const explicitProductId = productIdIndex !== -1 ? row[productIdIndex]?.trim() : null;

        if (!sku) {
          result.errors.push(`Row ${rowNum}: Missing SKU`);
          result.failed++;
          continue;
        }

        if (isNaN(quantity) || quantity < 0) {
          result.errors.push(`Row ${rowNum}: Invalid quantity "${row[quantityIndex]}"`);
          result.failed++;
          continue;
        }

        // Find product by SKU or explicit product ID
        let productInfo = skuToProduct[sku];

        if (!productInfo && explicitProductId) {
          const product = await getDocument('merch', explicitProductId);
          if (product) {
            productInfo = { productId: explicitProductId, product };
          }
        }

        if (!productInfo) {
          result.errors.push(`Row ${rowNum}: SKU "${sku}" not found`);
          result.failed++;
          continue;
        }

        const { productId, variantKey, product } = productInfo;

        // Calculate new stock
        let oldStock: number;
        let newStock: number;

        if (variantKey) {
          // Variant-level stock
          oldStock = product.variantStock?.[variantKey]?.stock ?? 0;
        } else {
          // Product-level stock
          oldStock = product.totalStock ?? product.stock ?? 0;
        }

        switch (rowOperation) {
          case 'add':
            newStock = oldStock + quantity;
            break;
          case 'subtract':
            newStock = Math.max(0, oldStock - quantity);
            break;
          case 'set':
          default:
            newStock = quantity;
            break;
        }

        // Update stock
        if (variantKey) {
          // Update variant stock
          const updatedVariantStock = { ...product.variantStock };
          updatedVariantStock[variantKey] = {
            ...updatedVariantStock[variantKey],
            stock: newStock
          };

          // Recalculate total stock
          const totalStock = Object.values(updatedVariantStock).reduce(
            (sum: number, v: any) => sum + (v.stock || 0), 0
          );

          await updateDocument('merch', productId, {
            variantStock: updatedVariantStock,
            totalStock,
            isLowStock: totalStock <= (product.lowStockThreshold || 5) && totalStock > 0,
            isOutOfStock: totalStock === 0,
            updatedAt: new Date().toISOString()
          });
        } else {
          // Update product-level stock
          await updateDocument('merch', productId, {
            stock: newStock,
            totalStock: newStock,
            isLowStock: newStock <= (product.lowStockThreshold || 5) && newStock > 0,
            isOutOfStock: newStock === 0,
            updatedAt: new Date().toISOString()
          });
        }

        // Record stock movement
        await addDocument('merch-stock-movements', {
          productId,
          productName: product.name || product.productName,
          variantKey: variantKey || null,
          sku,
          type: 'bulk_upload',
          operation: rowOperation,
          quantity: rowOperation === 'set' ? newStock : quantity,
          delta: newStock - oldStock,
          previousStock: oldStock,
          newStock,
          source: 'csv_import',
          createdAt: new Date().toISOString()
        });

        result.success++;
        result.updates.push({ sku, oldStock, newStock });

      } catch (rowErr: any) {
        result.errors.push(`Row ${rowNum}: ${rowErr.message}`);
        result.failed++;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      result
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[bulk-stock-upload] Error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Failed to process CSV'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET endpoint to download CSV template
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const format = url.searchParams.get('format');

  if (format === 'template') {
    const template = `sku,quantity,operation
SKU001,10,set
SKU002,5,add
SKU003,2,subtract`;

    return new Response(template, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="stock-upload-template.csv"'
      }
    });
  }

  // Export current stock as CSV
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const allMerch = await queryCollection('merch', { limit: 500 });

    const rows = ['sku,product_name,variant,stock,low_stock_threshold'];

    for (const product of allMerch) {
      if (product.variantStock) {
        for (const [variantKey, variant] of Object.entries(product.variantStock as Record<string, any>)) {
          rows.push([
            variant.sku || `${product.sku || product.id}_${variantKey}`,
            `"${(product.name || product.productName || '').replace(/"/g, '""')}"`,
            variantKey,
            variant.stock || 0,
            product.lowStockThreshold || 5
          ].join(','));
        }
      } else {
        rows.push([
          product.sku || product.id,
          `"${(product.name || product.productName || '').replace(/"/g, '""')}"`,
          '',
          product.stock || product.totalStock || 0,
          product.lowStockThreshold || 5
        ].join(','));
      }
    }

    return new Response(rows.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="stock-export-${new Date().toISOString().split('T')[0]}.csv"`
      }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
