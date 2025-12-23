// src/pages/api/admin/clear-chat.ts
// Admin endpoint to clear all chat messages
import type { APIRoute } from 'astro';
import { queryCollection, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const body = await request.json().catch(() => ({}));

    // Check admin auth (pass body for adminKey check)
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { streamId } = body;

    let chatMessages;

    if (streamId) {
      // Clear messages for specific stream
      chatMessages = await queryCollection('livestream-chat', {
        filters: [{ field: 'streamId', op: 'EQUAL', value: streamId }]
      });
    } else {
      // Clear ALL chat messages
      chatMessages = await queryCollection('livestream-chat', {});
    }

    if (!chatMessages || chatMessages.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No messages to clear',
        deleted: 0
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Delete all messages
    const deletePromises = chatMessages.map((msg: any) =>
      deleteDocument('livestream-chat', msg.id).catch(err => {
        console.error(`Failed to delete message ${msg.id}:`, err);
        return null;
      })
    );

    await Promise.all(deletePromises);

    console.log(`[Admin] Cleared ${chatMessages.length} chat messages${streamId ? ` for stream ${streamId}` : ' (all)'}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Cleared ${chatMessages.length} chat messages`,
      deleted: chatMessages.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Clear chat error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to clear chat'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  // Check admin auth
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    // Get count of chat messages
    const chatMessages = await queryCollection('livestream-chat', {});

    return new Response(JSON.stringify({
      success: true,
      count: chatMessages?.length || 0
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Get chat count error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
