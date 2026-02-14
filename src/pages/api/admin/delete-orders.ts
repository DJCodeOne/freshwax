// src/pages/api/admin/delete-orders.ts
// Admin endpoint to delete orders - requires admin key
import type { APIRoute } from 'astro';
import { deleteDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;

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
  const authError = await requireAdminAuth(request, locals, body);
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
        results.push({ id: orderId, success: false, error: 'Internal error' });
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
      error: 'Internal error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
