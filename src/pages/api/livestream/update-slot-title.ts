// src/pages/api/livestream/update-slot-title.ts
// Update livestream slot title (for relay streams)

import type { APIRoute } from 'astro';
import { saUpdateDocument, getServiceAccountToken } from '../../../lib/firebase-service-account';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;

  try {
    const data = await request.json();
    const { slotId, title, startTime, endTime, adminKey } = data;

    // Require admin key for security
    const expectedAdminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
    if (!adminKey || adminKey !== expectedAdminKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    if (!slotId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'slotId is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Build service account key from env vars
    const serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
      private_key_id: 'auto',
      private_key: (env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      client_email: env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
      client_id: '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    });

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    // Build update object with provided fields
    const updateData: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (title) updateData.title = title;
    if (startTime) updateData.startTime = startTime;
    if (endTime) updateData.endTime = endTime;

    // Update the slot
    await saUpdateDocument(serviceAccountKey, projectId, 'livestreamSlots', slotId, updateData);

    return new Response(JSON.stringify({
      success: true,
      message: 'Slot updated successfully',
      updated: updateData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[update-slot-title] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to update title'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
