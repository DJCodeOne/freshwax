// src/pages/api/stream/list-djs.ts
// List approved DJs who can go live
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const approvedOnly = url.searchParams.get('approved') === 'true';
  
  try {
    // Get DJs from djLobbyBypass collection (those granted access)
    const bypassSnapshot = await db.collection('djLobbyBypass')
      .orderBy('grantedAt', 'desc')
      .limit(50)
      .get();
    
    const djs = await Promise.all(bypassSnapshot.docs.map(async (doc) => {
      const data = doc.data();
      const userId = doc.id;
      
      // Get additional user info
      let djName = data.name || data.email?.split('@')[0] || 'Unknown DJ';
      let email = data.email || '';
      let lastStreamAt = null;
      
      // Try to get more info from users collection
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          djName = userData?.displayName || userData?.name || djName;
          email = userData?.email || email;
        }
      } catch (e) {
        // Ignore
      }
      
      // Try to get last stream
      try {
        const streamsSnapshot = await db.collection('livestreams')
          .where('userId', '==', userId)
          .orderBy('startedAt', 'desc')
          .limit(1)
          .get();
        
        if (!streamsSnapshot.empty) {
          const streamData = streamsSnapshot.docs[0].data();
          lastStreamAt = streamData.startedAt?.toDate?.()?.toISOString() || null;
        }
      } catch (e) {
        // Ignore - might not have index
      }
      
      return {
        userId,
        djName,
        email,
        grantedAt: data.grantedAt?.toDate?.()?.toISOString() || null,
        reason: data.reason || null,
        lastStreamAt,
        // Placeholder values for Icecast integration
        icecastMountPoint: `/live/${userId.substring(0, 8)}`,
        twitchChannel: null
      };
    }));
    
    return new Response(JSON.stringify({
      success: true,
      djs
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    console.error('[list-djs] Error:', error);
    return new Response(JSON.stringify({
      success: true,
      djs: [],
      error: error.message
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
