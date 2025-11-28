// src/pages/api/get-merch.ts
// Fetches merch products from Firebase with filtering options

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

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

export const GET: APIRoute = async ({ url }) => {
  try {
    console.log('[GET-MERCH] Fetching products from Firebase...');
    
    // Parse query parameters
    const params = url.searchParams;
    const category = params.get('category');
    const productType = params.get('type');
    const supplierId = params.get('supplier');
    const publishedOnly = params.get('published') !== 'false';
    const inStockOnly = params.get('inStock') === 'true';
    const featured = params.get('featured') === 'true';
    const limit = parseInt(params.get('limit') || '100');
    
    // Build query
    let query: FirebaseFirestore.Query = db.collection('merch');
    
    if (publishedOnly) {
      query = query.where('published', '==', true);
    }
    
    if (category) {
      query = query.where('category', '==', category);
    }
    
    if (productType) {
      query = query.where('productType', '==', productType);
    }
    
    if (supplierId) {
      query = query.where('supplierId', '==', supplierId);
    }
    
    if (featured) {
      query = query.where('featured', '==', true);
    }
    
    // Execute query
    const snapshot = await query.limit(limit).get();
    
    let products: any[] = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Filter in-stock if requested
      if (inStockOnly && data.totalStock <= 0) {
        return;
      }
      
      products.push({
        id: doc.id,
        ...data
      });
    });
    
    // Sort by createdAt (newest first)
    products.sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    // Calculate summary stats
    const stats = {
      total: products.length,
      inStock: products.filter(p => p.totalStock > 0).length,
      outOfStock: products.filter(p => p.totalStock === 0).length,
      lowStock: products.filter(p => p.isLowStock && p.totalStock > 0).length,
      featured: products.filter(p => p.featured).length,
      onSale: products.filter(p => p.onSale).length,
    };
    
    // Group by category for navigation
    const byCategory: Record<string, any[]> = {};
    products.forEach(p => {
      if (!byCategory[p.category]) {
        byCategory[p.category] = [];
      }
      byCategory[p.category].push(p);
    });
    
    // Group by product type
    const byType: Record<string, any[]> = {};
    products.forEach(p => {
      if (!byType[p.productType]) {
        byType[p.productType] = [];
      }
      byType[p.productType].push(p);
    });
    
    console.log(`[GET-MERCH] ✓ Loaded ${products.length} products`);
    
    return new Response(JSON.stringify({
      success: true,
      products: products,
      stats: stats,
      byCategory: byCategory,
      byType: byType,
      source: 'firebase'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
    
  } catch (error) {
    console.error('[GET-MERCH] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch products',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};