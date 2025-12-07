// src/pages/api/admin/dj-moderation.ts
// Admin API for DJ moderation: ban, hold, kick
// - Banned DJs cannot access DJ Lobby or Go Live
// - DJs on hold cannot go live but can view lobby
// - Kicked DJs have their stream ended but retain DJ role

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

// GET: List banned and on-hold DJs
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
    const [bannedSnap, onholdSnap] = await Promise.all([
      db.collection('djModeration').where('status', '==', 'banned').orderBy('bannedAt', 'desc').get(),
      db.collection('djModeration').where('status', '==', 'hold').orderBy('holdAt', 'desc').get()
    ]);
    
    const banned = bannedSnap.docs.map(doc => ({
      id: doc.id,
      oduserId: doc.id,
      ...doc.data(),
      bannedAt: doc.data().bannedAt?.toDate?.().toISOString() || null
    }));
    
    const onhold = onholdSnap.docs.map(doc => ({
      id: doc.id,
      oduserId: doc.id,
      ...doc.data(),
      holdAt: doc.data().holdAt?.toDate?.().toISOString() || null
    }));
    
    return new Response(JSON.stringify({ success: true, banned, onhold }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[dj-moderation] Error listing:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Ban, unban, hold, release, or kick a DJ
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
    
    // Helper to get userId from email
    async function getUserIdFromEmail(email: string): Promise<{ userId: string; name: string | null } | null> {
      try {
        const userRecord = await auth.getUserByEmail(email);
        return { userId: userRecord.uid, name: userRecord.displayName || null };
      } catch (e) {
        return null;
      }
    }
    
    if (action === 'ban') {
      if (!email) {
        return new Response(JSON.stringify({ success: false, error: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const user = await getUserIdFromEmail(email);
      if (!user) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'User not found with that email' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Add to moderation collection
      await db.collection('djModeration').doc(user.userId).set({
        email,
        name: user.name,
        status: 'banned',
        reason: reason || null,
        bannedAt: FieldValue.serverTimestamp(),
        bannedBy: 'admin'
      });
      
      // Also end any active stream they have
      const activeStreams = await db.collection('streams')
        .where('djId', '==', user.userId)
        .where('status', '==', 'live')
        .get();
      
      for (const streamDoc of activeStreams.docs) {
        await streamDoc.ref.update({
          status: 'ended',
          endedAt: FieldValue.serverTimestamp(),
          endReason: 'banned'
        });
      }
      
      console.log(`[dj-moderation] Banned ${email} (${user.userId})`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: `${email} has been banned`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'unban') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await db.collection('djModeration').doc(userId).delete();
      
      console.log(`[dj-moderation] Unbanned ${userId}`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'DJ has been unbanned'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'hold') {
      if (!email) {
        return new Response(JSON.stringify({ success: false, error: 'Email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const user = await getUserIdFromEmail(email);
      if (!user) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'User not found with that email' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Add to moderation collection with hold status
      await db.collection('djModeration').doc(user.userId).set({
        email,
        name: user.name,
        status: 'hold',
        reason: reason || null,
        holdAt: FieldValue.serverTimestamp(),
        holdBy: 'admin'
      });
      
      // End any active stream
      const activeStreams = await db.collection('streams')
        .where('djId', '==', user.userId)
        .where('status', '==', 'live')
        .get();
      
      for (const streamDoc of activeStreams.docs) {
        await streamDoc.ref.update({
          status: 'ended',
          endedAt: FieldValue.serverTimestamp(),
          endReason: 'hold'
        });
      }
      
      console.log(`[dj-moderation] Put ${email} on hold (${user.userId})`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: `${email} has been put on hold`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'release') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await db.collection('djModeration').doc(userId).delete();
      
      console.log(`[dj-moderation] Released ${userId} from hold`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'DJ has been released from hold'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'kick') {
      if (!userId) {
        return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // End any active stream but don't ban
      const activeStreams = await db.collection('streams')
        .where('djId', '==', userId)
        .where('status', '==', 'live')
        .get();
      
      if (activeStreams.empty) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'DJ is not currently streaming' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      for (const streamDoc of activeStreams.docs) {
        await streamDoc.ref.update({
          status: 'ended',
          endedAt: FieldValue.serverTimestamp(),
          endReason: 'kicked'
        });
      }
      
      // Update currentStream document if exists
      try {
        await db.collection('livestream').doc('currentStream').update({
          isLive: false,
          endedAt: FieldValue.serverTimestamp()
        });
      } catch (e) {
        // May not exist
      }
      
      console.log(`[dj-moderation] Kicked ${userId} from stream`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'DJ has been kicked from the stream'
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
    console.error('[dj-moderation] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
