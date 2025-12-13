// src/pages/api/newsletter/subscribers.ts
// Get all subscribers for admin dashboard
import type { APIRoute } from 'astro';
import { queryCollection, deleteDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const GET: APIRoute = async ({ cookies, locals }) => {
  initFirebase(locals);
  try {
    // Check admin auth
    const adminId = cookies.get('adminId')?.value;
    if (!adminId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const allSubscribers = await queryCollection('subscribers', {
      orderBy: { field: 'subscribedAt', direction: 'DESCENDING' }
    });

    const subscribers = allSubscribers.map(doc => {
      return {
        id: doc.id,
        email: doc.email,
        status: doc.status || 'active',
        source: doc.source || 'unknown',
        subscribedAt: doc.subscribedAt instanceof Date ? doc.subscribedAt.toISOString() : null,
        emailsSent: doc.emailsSent || 0,
        emailsOpened: doc.emailsOpened || 0,
        lastEmailSentAt: doc.lastEmailSentAt instanceof Date ? doc.lastEmailSentAt.toISOString() : null
      };
    });

    // Get stats
    const stats = {
      total: subscribers.length,
      active: subscribers.filter(s => s.status === 'active').length,
      unsubscribed: subscribers.filter(s => s.status === 'unsubscribed').length
    };

    return new Response(JSON.stringify({
      success: true,
      subscribers,
      stats
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Newsletter] Get subscribers error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch subscribers'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Delete subscriber
export const DELETE: APIRoute = async ({ request, cookies, locals }) => {
  initFirebase(locals);
  try {
    const adminId = cookies.get('adminId')?.value;
    if (!adminId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { subscriberId } = await request.json();

    if (!subscriberId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Subscriber ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await deleteDocument('subscribers', subscriberId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscriber deleted'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Newsletter] Delete subscriber error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete subscriber'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Update subscriber status (unsubscribe/resubscribe)
export const PATCH: APIRoute = async ({ request, cookies, locals }) => {
  initFirebase(locals);
  try {
    const adminId = cookies.get('adminId')?.value;
    if (!adminId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { subscriberId, status } = await request.json();

    if (!subscriberId || !status) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Subscriber ID and status required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!['active', 'unsubscribed'].includes(status)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid status'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await updateDocument('subscribers', subscriberId, {
      status,
      updatedAt: new Date()
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Subscriber ${status === 'active' ? 'reactivated' : 'unsubscribed'}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Newsletter] Update subscriber error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update subscriber'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
