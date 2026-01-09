// src/pages/api/admin/delete-orders.ts
// Admin endpoint to delete orders - requires admin key
import type { APIRoute } from 'astro';
import { deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Parse body first for admin key check
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid JSON body'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Check admin auth (supports Authorization header, X-Admin-Key header, or adminKey in body)
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const { orderIds } = body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'orderIds array is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Safety limit
    if (orderIds.length > 50) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Maximum 50 orders can be deleted at once'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const results: { id: string; success: boolean; error?: string }[] = [];

    for (const orderId of orderIds) {
      try {
        await deleteDocument('orders', orderId);
        results.push({ id: orderId, success: true });
        console.log(`[delete-orders] Deleted order: ${orderId}`);
      } catch (error: any) {
        results.push({ id: orderId, success: false, error: error.message });
        console.error(`[delete-orders] Failed to delete ${orderId}:`, error.message);
      }
    }

    const deleted = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return new Response(JSON.stringify({
      success: true,
      deleted,
      failed,
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[delete-orders] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
