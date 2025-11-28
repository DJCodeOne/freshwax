// src/pages/api/get-merch.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const merchId = url.searchParams.get('id');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 50;
  
  try {
    // If specific ID requested, fetch single item
    if (merchId) {
      console.log(`[GET-MERCH] Fetching merch item: ${merchId}`);
      
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
    
    // Otherwise, fetch all merch
    console.log(`[GET-MERCH] Fetching up to ${limit} merch items...`);
    
    // Try to get published/active items first
    let items = await queryCollection('merch', {
      filters: [{ field: 'published', op: 'EQUAL', value: true }]
    });
    
    // If no results, try 'active' field
    if (items.length === 0) {
      items = await queryCollection('merch', {
        filters: [{ field: 'active', op: 'EQUAL', value: true }]
      });
    }
    
    // If still no results, get all items
    if (items.length === 0) {
      const { listCollection } = await import('../../lib/firebase-rest');
      const result = await listCollection('merch', limit);
      items = result.documents;
    }
    
    // Normalize merch data
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
    
    // Sort by name or date added
    normalizedItems.sort((a, b) => {
      if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
        return a.sortOrder - b.sortOrder;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
    
    // Apply limit
    const limitedItems = limit > 0 ? normalizedItems.slice(0, limit) : normalizedItems;
    
    console.log(`[GET-MERCH] ✓ Returning ${limitedItems.length} items`);
    
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
    console.error('[GET-MERCH] Error:', error);
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