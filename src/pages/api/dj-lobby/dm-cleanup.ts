// src/pages/api/dj-lobby/dm-cleanup.ts
// Clean up DJ direct messages when a DM conversation is closed
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { deleteDocument, verifyUserToken } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const dmCleanupSchema = z.object({
  channelId: z.string().min(1),
});

const log = createLogger('dj-lobby/dm-cleanup');

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

  const response = await fetchWithTimeout(url, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    }
  }, 10000);

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  if (!data.documents) return [];

  return data.documents.map((doc: Record<string, unknown>) => {
    const parts = doc.name.split('/');
    return parts[parts.length - 1];
  });
}

// Delete a document in a subcollection (bypasses validatePath which rejects '/')
async function deleteSubcollectionDoc(parentPath: string, docId: string, idToken: string): Promise<void> {
  const { baseUrl, apiKey } = getFirestoreBaseUrl();
  const url = `${baseUrl}/${parentPath}/${docId}?key=${apiKey}`;

  const response = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    }
  }, 10000);

  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    log.error(`Failed to delete ${parentPath}/${docId}:`, error);
  }
}

// POST: Clean up DM messages for a channel
export const POST: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dj-lobby-dm-cleanup:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const userId = await verifyUserToken(idToken);
    if (!userId) {
      return ApiErrors.forbidden('Invalid token');
    }

    const data = await request.json();
    const parseResult = dmCleanupSchema.safeParse(data);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { channelId } = parseResult.data;

    // Verify the user is part of this DM channel
    // Channel IDs are formatted as sorted uid pair: "uid1_uid2"
    const channelParts = channelId.split('_');
    if (!channelParts.includes(userId)) {
      return ApiErrors.forbidden('You can only clean up your own DM channels');
    }

    // List all messages in the subcollection
    const messagePath = `djDirectMessages/${channelId}/messages`;
    const messageIds = await listSubcollectionDocs(messagePath, idToken);

    // Delete all messages using subcollection-aware helper
    const deletePromises = messageIds.map(msgId =>
      deleteSubcollectionDoc(`djDirectMessages/${channelId}/messages`, msgId, idToken)
    );
    const results = await Promise.allSettled(deletePromises);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      log.error('Some DM deletes failed', { count: failures.length });
    }

    // Delete the channel document itself
    await deleteDocument('djDirectMessages', channelId);

    return successResponse({ message: 'DM channel cleaned up',
      messagesDeleted: messageIds.length - failures.length });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to clean up DMs');
  }
};
