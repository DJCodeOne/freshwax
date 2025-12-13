// src/pages/api/livestream/chat-cleanup.ts
// API to schedule and execute chat cleanup after DJ session ends
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

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

      await setDocument('chatCleanupSchedule', streamId, {
        streamId,
        scheduledAt: new Date().toISOString(),
        cleanupAt: cleanupTime.toISOString(),
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
      await deleteDocument('chatCleanupSchedule', streamId);

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
      await updateDocument('chatCleanupSchedule', streamId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
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
    const allPending = await queryCollection('chatCleanupSchedule', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }]
    });

    const pending = allPending.filter((job: any) => {
      const cleanupAt = new Date(job.cleanupAt);
      return cleanupAt <= now;
    });
    
    if (!executeNow) {
      return new Response(JSON.stringify({
        success: true,
        pendingCleanups: pending.length,
        jobs: pending.map((j: any) => ({
          streamId: j.streamId,
          cleanupAt: j.cleanupAt
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

          await updateDocument('chatCleanupSchedule', job.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            messagesDeleted: deleted
          });

          return { streamId: job.streamId, success: true, deleted };
        } catch (error: any) {
          await updateDocument('chatCleanupSchedule', job.id, {
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
  // Get all chat messages for this stream
  const chatMessages = await queryCollection('livestream-chat', {
    filters: [{ field: 'streamId', op: 'EQUAL', value: streamId }]
  });

  // Delete all messages (note: REST API doesn't support batch operations)
  await Promise.all(chatMessages.map(msg =>
    deleteDocument('livestream-chat', msg.id)
  ));

  const deleted = chatMessages.length;
  console.log(`[Chat Cleanup] Deleted ${deleted} messages for stream ${streamId}`);

  return deleted;
}
