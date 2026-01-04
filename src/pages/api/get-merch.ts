// src/pages/api/get-merch.ts
// Uses Firebase REST API - works on Cloudflare Pages
// Uses KV caching to reduce Firebase reads
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet, CACHE_CONFIG } from '../../lib/kv-cache';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initKVCache(env);

  const url = new URL(request.url);
  const merchId = url.searchParams.get('id');
  const limitParam = url.searchParams.get('limit');
  const publishedParam = url.searchParams.get('published');
  const limit = limitParam ? parseInt(limitParam) : 50;
  const skipCache = url.searchParams.get('fresh') === '1';

  try {
    if (merchId) {
      log.info('[get-merch] Fetching merch item:', merchId);

      // Check KV cache for single item
      const itemCacheKey = `item:${merchId}`;
      if (!skipCache) {
        const cached = await kvGet(itemCacheKey, CACHE_CONFIG.MERCH);
        if (cached) {
          log.info('[get-merch] KV cache hit for item:', merchId);
          return new Response(JSON.stringify(cached), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=300, s-maxage=300'
            }
          });
        }
      }

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

      const result = {
        success: true,
        item,
        source: 'firebase-rest'
      };

      kvSet(itemCacheKey, result, CACHE_CONFIG.MERCH);

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300'
        }
      });
    }
    
    log.info('[get-merch] Fetching up to', limit, 'items, published:', publishedParam);

    // Check KV cache for list
    const listCacheKey = `list:${limit}:${publishedParam || 'default'}`;
    if (!skipCache) {
      const cached = await kvGet(listCacheKey, CACHE_CONFIG.MERCH);
      if (cached) {
        log.info('[get-merch] KV cache hit for list');
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300, s-maxage=300'
          }
        });
      }
    }

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

    const result = {
      success: true,
      items: limitedItems,
      products: limitedItems, // Alias for manage.astro compatibility
      total: limitedItems.length,
      stats,
      source: 'firebase-rest'
    };

    // Cache in KV for 5 minutes
    kvSet(listCacheKey, result, CACHE_CONFIG.MERCH);

    return new Response(JSON.stringify(result), {
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
