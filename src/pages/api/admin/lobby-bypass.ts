// src/pages/api/admin/lobby-bypass.ts
// Admin API for managing DJ lobby access bypass
// Allows admins to grant/revoke access to DJs who don't meet the 10 likes requirement

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

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
const auth = getAuth();

const ADMIN_KEY = 'freshwax-admin-2024';

// GET: List all bypass approvals
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  
  if (action !== 'list') {
    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const snapshot = await db.collection('djLobbyBypass').orderBy('grantedAt', 'desc').get();
    
    const bypasses = snapshot.docs.map(doc => ({
      id: doc.id,
      userId: doc.id,
      ...doc.data(),
      grantedAt: doc.data().grantedAt?.toDate?.().toISOString() || null
    }));
    
    return new Response(JSON.stringify({ success: true, bypasses }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[lobby-bypass] Error listing:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Grant or revoke bypass
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action, email, userId, reason, adminKey } = data;
    
    // Simple admin key check
    if (adminKey !== ADMIN_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (action === 'grant') {
      if (!email) {
        return new Response(JSON.stringify({ success: false, error: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Find user by email
      let targetUserId: string;
      let userName: string | null = null;
      
      try {
        const userRecord = await auth.getUserByEmail(email);
        targetUserId = userRecord.uid;
        userName = userRecord.displayName || null;
      } catch (e) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'User not found with that email. They need to create an account first.' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Grant bypass
      await db.collection('djLobbyBypass').doc(targetUserId).set({
        email,
        name: userName,
        reason: reason || null,
        grantedAt: FieldValue.serverTimestamp(),
        grantedBy: 'admin'
      });
      
      console.log(`[lobby-bypass] Granted bypass to ${email} (${targetUserId})`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: `Lobby access granted to ${email}`,
        userId: targetUserId
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'revoke') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Revoke bypass
      await db.collection('djLobbyBypass').doc(userId).delete();
      
      console.log(`[lobby-bypass] Revoked bypass for ${userId}`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Bypass revoked'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else {
      return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
  } catch (error: any) {
    console.error('[lobby-bypass] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
