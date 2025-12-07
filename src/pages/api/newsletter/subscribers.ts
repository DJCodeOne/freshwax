// src/pages/api/newsletter/subscribers.ts
// Get all subscribers for admin dashboard
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const prerender = false;

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export const GET: APIRoute = async ({ cookies }) => {
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
    
    const db = getFirestore();
    
    const snapshot = await db.collection('subscribers')
      .orderBy('subscribedAt', 'desc')
      .get();
    
    const subscribers = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        email: data.email,
        status: data.status || 'active',
        source: data.source || 'unknown',
        subscribedAt: data.subscribedAt?.toDate?.()?.toISOString() || null,
        emailsSent: data.emailsSent || 0,
        emailsOpened: data.emailsOpened || 0,
        lastEmailSentAt: data.lastEmailSentAt?.toDate?.()?.toISOString() || null
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
export const DELETE: APIRoute = async ({ request, cookies }) => {
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
    
    const db = getFirestore();
    await db.collection('subscribers').doc(subscriberId).delete();
    
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
export const PATCH: APIRoute = async ({ request, cookies }) => {
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
    
    const db = getFirestore();
    await db.collection('subscribers').doc(subscriberId).update({
      status,
      updatedAt: FieldValue.serverTimestamp()
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
