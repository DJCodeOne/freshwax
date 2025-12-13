// src/pages/api/get-stock-movements.ts
// Get stock movement history

import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  try {
    const params = url.searchParams;
    const productId = params.get('productId');
    const type = params.get('type');
    const limit = parseInt(params.get('limit') || '50');
    const supplierId = params.get('supplierId');

    // Build filters
    const filters: Array<{field: string, op: any, value: any}> = [];

    if (productId) {
      filters.push({ field: 'productId', op: 'EQUAL', value: productId });
    }

    if (type && type !== 'all') {
      filters.push({ field: 'type', op: 'EQUAL', value: type });
    }

    if (supplierId) {
      filters.push({ field: 'supplierId', op: 'EQUAL', value: supplierId });
    }

    const movements = await queryCollection('merch-stock-movements', {
      filters: filters.length > 0 ? filters : undefined,
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit: Math.min(limit, 200)
    });

    // Calculate summary stats
    const summary = {
      totalReceived: 0,
      totalSold: 0,
      totalDamaged: 0,
      totalReturned: 0,
      totalAdjusted: 0
    };

    movements.forEach(m => {
      switch (m.type) {
        case 'receive':
          summary.totalReceived += m.quantity || 0;
          break;
        case 'sell':
          summary.totalSold += m.quantity || 0;
          break;
        case 'damaged':
          summary.totalDamaged += Math.abs(m.quantity || 0);
          break;
        case 'return':
          summary.totalReturned += m.quantity || 0;
          break;
        case 'adjust':
          summary.totalAdjusted += m.stockDelta || 0;
          break;
      }
    });

    return new Response(JSON.stringify({
      success: true,
      count: movements.length,
      summary: summary,
      movements: movements
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[get-stock-movements] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch movements',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
