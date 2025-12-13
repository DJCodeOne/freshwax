// src/pages/api/get-merch.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const merchId = url.searchParams.get('id');
  const limitParam = url.searchParams.get('limit');
  const publishedParam = url.searchParams.get('published');
  const limit = limitParam ? parseInt(limitParam) : 50;
  
  try {
    if (merchId) {
      log.info('[get-merch] Fetching merch item:', merchId);
      
      const item = await getDocument('merch', merchId);
      
      if (!item) {
        return new Response(JSON.stringify({ 
          success: false,
          error: 'Merch item not found' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({ 
        success: true,
        item,
        source: 'firebase-rest'
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300'
        }
      });
    }
    
    log.info('[get-merch] Fetching up to', limit, 'items, published:', publishedParam);
    
    let items: any[] = [];
    
    // If published=all, get all items without filtering
    if (publishedParam === 'all') {
      // queryCollection without filters returns all documents
      items = await queryCollection('merch', { limit });
    } else {
      // Default: try published=true, then active=true, then all
      items = await queryCollection('merch', {
        filters: [{ field: 'published', op: 'EQUAL', value: true }],
        limit
      });
      
      if (!items || items.length === 0) {
        items = await queryCollection('merch', {
          filters: [{ field: 'active', op: 'EQUAL', value: true }],
          limit
        });
      }
      
      if (!items || items.length === 0) {
        items = await queryCollection('merch', { limit });
      }
    }
    
    // Ensure items is always an array
    if (!Array.isArray(items)) {
      items = [];
    }
    
    const normalizedItems = items.map(item => {
      // Normalize images to always be string URLs
      const rawImages = item.images || [];
      const normalizedImages = rawImages.map((img: any) => 
        typeof img === 'string' ? img : img?.url
      ).filter(Boolean);
      
      // Use normalized images or fall back to legacy imageUrl
      const images = normalizedImages.length > 0 
        ? normalizedImages 
        : (item.imageUrl ? [item.imageUrl] : []);
      
      return {
        // Spread original item first
        ...item,
        // Then override with normalized values
        id: item.id,
        name: item.name || item.title || 'Untitled Item',
        description: item.description || '',
        price: item.price || 0,
        currency: item.currency || 'GBP',
        images,
        primaryImage: images[0] || item.primaryImage || null,
        category: item.category || 'general',
        inStock: item.inStock !== false && (item.stock === undefined || item.stock > 0),
        stock: item.stock,
        variants: item.variants || [],
        published: item.published ?? true,
        active: item.active ?? true,
        featured: item.featured ?? false,
        onSale: item.onSale ?? false,
        salePrice: item.salePrice || null,
        sku: item.sku || item.id,
      };
    });
    
    normalizedItems.sort((a, b) => {
      if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
        return a.sortOrder - b.sortOrder;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
    
    const limitedItems = limit > 0 ? normalizedItems.slice(0, limit) : normalizedItems;
    
    // Calculate stats for admin dashboard
    const stats = {
      total: limitedItems.length,
      inStock: limitedItems.filter(p => p.inStock).length,
      lowStock: limitedItems.filter(p => p.stock !== undefined && p.stock > 0 && p.stock <= 5).length,
      outOfStock: limitedItems.filter(p => p.stock !== undefined && p.stock === 0).length,
      featured: limitedItems.filter(p => p.featured).length,
      onSale: limitedItems.filter(p => p.onSale).length
    };
    
    log.info('[get-merch] Returning', limitedItems.length, 'items');
    
    return new Response(JSON.stringify({ 
      success: true,
      items: limitedItems,
      products: limitedItems, // Alias for manage.astro compatibility
      total: limitedItems.length,
      stats,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
    
  } catch (error) {
    log.error('[get-merch] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch merch',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
