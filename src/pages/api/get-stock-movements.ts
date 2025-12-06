// src/pages/api/get-stock-movements.ts
// Get stock movement history

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

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
    const params = url.searchParams;
    const productId = params.get('productId');
    const type = params.get('type');
    const limit = parseInt(params.get('limit') || '50');
    const supplierId = params.get('supplierId');
    
    let query: FirebaseFirestore.Query = db.collection('merch-stock-movements')
      .orderBy('createdAt', 'desc')
      .limit(Math.min(limit, 200));
    
    if (productId) {
      query = query.where('productId', '==', productId);
    }
    
    if (type && type !== 'all') {
      query = query.where('type', '==', type);
    }
    
    if (supplierId) {
      query = query.where('supplierId', '==', supplierId);
    }
    
    const snapshot = await query.get();
    
    const movements: any[] = [];
    snapshot.forEach(doc => {
      movements.push({
        id: doc.id,
        ...doc.data()
      });
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
