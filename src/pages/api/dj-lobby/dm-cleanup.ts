// src/pages/api/dj-lobby/dm-cleanup.ts
// Clean up DJ direct messages when a DM conversation is closed
import type { APIRoute } from 'astro';
import { deleteDocument, verifyUserToken } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to get Firestore REST base URL
function getFirestoreBaseUrl(): { baseUrl: string; apiKey: string } {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const apiKey = import.meta.env.FIREBASE_API_KEY || import.meta.env.PUBLIC_FIREBASE_API_KEY;
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  return { baseUrl, apiKey };
}

// List documents in a subcollection using Firestore REST list API
async function listSubcollectionDocs(parentPath: string, idToken: string): Promise<string[]> {
  const { baseUrl, apiKey } = getFirestoreBaseUrl();
  const url = `${baseUrl}/${parentPath}?key=${apiKey}&pageSize=500`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  if (!data.documents) return [];

  return data.documents.map((doc: any) => {
    const parts = doc.name.split('/');
    return parts[parts.length - 1];
  });
}

// Delete a document in a subcollection (bypasses validatePath which rejects '/')
async function deleteSubcollectionDoc(parentPath: string, docId: string, idToken: string): Promise<void> {
  const { baseUrl, apiKey } = getFirestoreBaseUrl();
  const url = `${baseUrl}/${parentPath}/${docId}?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    }
  });

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    console.error(`[dm-cleanup] Failed to delete ${parentPath}/${docId}:`, error);
  }
}

// POST: Clean up DM messages for a channel
export const POST: APIRoute = async ({ request }) => {
  try {
    // Verify authentication
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    if (!idToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const userId = await verifyUserToken(idToken);
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid token'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await request.json();
    const { channelId } = data;

    if (!channelId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Channel ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the user is part of this DM channel
    // Channel IDs are formatted as sorted uid pair: "uid1_uid2"
    const channelParts = channelId.split('_');
    if (!channelParts.includes(userId)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only clean up your own DM channels'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // List all messages in the subcollection
    const messagePath = `djDirectMessages/${channelId}/messages`;
    const messageIds = await listSubcollectionDocs(messagePath, idToken);

    // Delete all messages using subcollection-aware helper
    const deletePromises = messageIds.map(msgId =>
      deleteSubcollectionDoc(`djDirectMessages/${channelId}/messages`, msgId, idToken)
    );
    await Promise.all(deletePromises);

    // Delete the channel document itself
    await deleteDocument('djDirectMessages', channelId);

    return new Response(JSON.stringify({
      success: true,
      message: 'DM channel cleaned up',
      messagesDeleted: messageIds.length
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[dj-lobby/dm-cleanup] Error:', error?.message || error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to clean up DMs'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
