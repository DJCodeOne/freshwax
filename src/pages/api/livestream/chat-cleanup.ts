// src/pages/api/livestream/chat-cleanup.ts
// API to schedule and execute chat cleanup after DJ session ends
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

const db = getFirestore();

// POST - Schedule chat cleanup for a stream
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { streamId, action } = data;
    
    if (!streamId) {
      return new Response(JSON.stringify({ success: false, error: 'Stream ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (action === 'schedule') {
      // Schedule cleanup for 30 minutes from now
      const cleanupTime = new Date(Date.now() + 30 * 60 * 1000);
      
      await db.collection('chatCleanupSchedule').doc(streamId).set({
        streamId,
        scheduledAt: FieldValue.serverTimestamp(),
        cleanupAt: cleanupTime,
        status: 'pending'
      });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Chat cleanup scheduled',
        cleanupAt: cleanupTime.toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (action === 'cancel') {
      // Cancel scheduled cleanup (if DJ comes back)
      await db.collection('chatCleanupSchedule').doc(streamId).delete();
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Chat cleanup cancelled'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (action === 'execute') {
      // Execute cleanup now
      const deleted = await deleteStreamChat(streamId);
      
      // Mark cleanup as complete
      await db.collection('chatCleanupSchedule').doc(streamId).update({
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        messagesDeleted: deleted
      });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Chat cleared',
        messagesDeleted: deleted
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Chat cleanup error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET - Check and execute pending cleanups (call this periodically)
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const executeNow = url.searchParams.get('execute') === 'true';
    
    // Find pending cleanups that are past their scheduled time
    const now = new Date();
    const snapshot = await db.collection('chatCleanupSchedule')
      .where('status', '==', 'pending')
      .get();
    
    const pending = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((job: any) => {
        const cleanupAt = job.cleanupAt?.toDate?.() || new Date(job.cleanupAt);
        return cleanupAt <= now;
      });
    
    if (!executeNow) {
      return new Response(JSON.stringify({ 
        success: true, 
        pendingCleanups: pending.length,
        jobs: pending.map((j: any) => ({
          streamId: j.streamId,
          cleanupAt: j.cleanupAt?.toDate?.()?.toISOString() || j.cleanupAt
        }))
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Execute all pending cleanups
    const results = await Promise.all(
      pending.map(async (job: any) => {
        try {
          const deleted = await deleteStreamChat(job.streamId);
          
          await db.collection('chatCleanupSchedule').doc(job.id).update({
            status: 'completed',
            completedAt: FieldValue.serverTimestamp(),
            messagesDeleted: deleted
          });
          
          return { streamId: job.streamId, success: true, deleted };
        } catch (error: any) {
          await db.collection('chatCleanupSchedule').doc(job.id).update({
            status: 'failed',
            error: error.message
          });
          
          return { streamId: job.streamId, success: false, error: error.message };
        }
      })
    );
    
    return new Response(JSON.stringify({ 
      success: true, 
      executed: results.length,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Chat cleanup check error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Delete all chat messages for a stream
async function deleteStreamChat(streamId: string): Promise<number> {
  let deleted = 0;
  let batch = db.batch();
  let batchCount = 0;
  const BATCH_SIZE = 500;
  
  // Get all chat messages for this stream
  const chatSnapshot = await db.collection('livestream-chat')
    .where('streamId', '==', streamId)
    .get();
  
  for (const doc of chatSnapshot.docs) {
    batch.delete(doc.ref);
    batchCount++;
    deleted++;
    
    // Firestore batches max 500 operations
    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  
  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }
  
  console.log(`[Chat Cleanup] Deleted ${deleted} messages for stream ${streamId}`);
  
  return deleted;
}
