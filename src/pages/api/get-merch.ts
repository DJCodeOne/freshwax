// src/pages/api/get-merch.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, listCollection } from '../../lib/firebase-rest';

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
    
    log.info('[get-merch] Fetching up to', limit, 'items');
    
    let items = await queryCollection('merch', {
      filters: [{ field: 'published', op: 'EQUAL', value: true }]
    });
    
    if (items.length === 0) {
      items = await queryCollection('merch', {
        filters: [{ field: 'active', op: 'EQUAL', value: true }]
      });
    }
    
    if (items.length === 0) {
      const result = await listCollection('merch', limit);
      items = result.documents;
    }
    
    const normalizedItems = items.map(item => ({
      id: item.id,
      name: item.name || item.title || 'Untitled Item',
      description: item.description || '',
      price: item.price || 0,
      currency: item.currency || 'GBP',
      images: item.images || (item.imageUrl ? [item.imageUrl] : []),
      category: item.category || 'general',
      inStock: item.inStock !== false && (item.stock === undefined || item.stock > 0),
      stock: item.stock,
      variants: item.variants || [],
      ...item
    }));
    
    normalizedItems.sort((a, b) => {
      if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
        return a.sortOrder - b.sortOrder;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
    
    const limitedItems = limit > 0 ? normalizedItems.slice(0, limit) : normalizedItems;
    
    log.info('[get-merch] Returning', limitedItems.length, 'items');
    
    return new Response(JSON.stringify({ 
      success: true,
      items: limitedItems,
      total: limitedItems.length,
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