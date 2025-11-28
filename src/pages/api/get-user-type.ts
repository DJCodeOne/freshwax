// src/pages/api/get-user-type.ts
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');
  
  if (!uid) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Missing uid' 
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const db = getFirestore();
    
    console.log(`[GET-USER-TYPE] Checking user type for uid: ${uid}`);
    
    const [artistDoc, customerDoc] = await Promise.all([
      db.collection('artists').doc(uid).get(),
      db.collection('customers').doc(uid).get(),
    ]);
    
    let name = '';
    if (artistDoc.exists) {
      const data = artistDoc.data();
      name = data?.name || data?.artistName || '';
      console.log(`[GET-USER-TYPE] ✓ Artist found: ${name}`);
    } else if (customerDoc.exists) {
      const data = customerDoc.data();
      name = data?.name || data?.firstName || '';
      console.log(`[GET-USER-TYPE] ✓ Customer found: ${name}`);
    } else {
      console.log(`[GET-USER-TYPE] ⚠️ No user found for uid: ${uid}`);
    }
    
    return new Response(JSON.stringify({
      success: true,
      isArtist: artistDoc.exists,
      isCustomer: customerDoc.exists,
      name
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
  } catch (error) {
    console.error('[GET-USER-TYPE] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch user type',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};