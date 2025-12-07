// src/pages/api/newsletter/unsubscribe.ts
// Public endpoint for users to unsubscribe from newsletter
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { email } = body;
    
    if (!email) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Email is required' 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const db = getFirestore();
    const normalizedEmail = email.toLowerCase().trim();
    
    // Find subscriber
    const snapshot = await db.collection('subscribers')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      // Email not found - still return success to avoid email enumeration
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'If this email was subscribed, it has been unsubscribed.' 
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const subscriberDoc = snapshot.docs[0];
    
    // Update status to unsubscribed
    await subscriberDoc.ref.update({
      status: 'unsubscribed',
      unsubscribedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Successfully unsubscribed from newsletter' 
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[Newsletter] Unsubscribe error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to unsubscribe. Please try again.' 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
