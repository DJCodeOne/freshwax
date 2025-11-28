// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

const db = getFirestore();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { partnerId } = await request.json();
    
    if (!partnerId) {
      return new Response(JSON.stringify({ error: 'Partner ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Update partner document
    await db.collection('artists').doc(partnerId).update({
      approved: true,
      approvedAt: FieldValue.serverTimestamp(),
      status: 'approved'
    });
    
    // TODO: Send approval email notification
    // You could integrate with an email service like Resend, SendGrid, etc.
    // const partner = await db.collection('artists').doc(partnerId).get();
    // await sendApprovalEmail(partner.data().email, partner.data().artistName);
    
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error approving partner:', error);
    return new Response(JSON.stringify({ error: 'Failed to approve partner' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};