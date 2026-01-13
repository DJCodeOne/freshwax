// src/pages/api/admin/fix-release-owner.ts
// Fix release submitterId to correct owner

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');
  const newOwnerId = url.searchParams.get('newOwnerId');
  const confirm = url.searchParams.get('confirm');

  if (!releaseId || !newOwnerId) {
    return new Response(JSON.stringify({
      error: 'Missing releaseId or newOwnerId',
      usage: '/api/admin/fix-release-owner?releaseId=xxx&newOwnerId=yyy&confirm=yes'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (confirm !== 'yes') {
    return new Response(JSON.stringify({
      message: `Would update release ${releaseId} to submitterId: ${newOwnerId}`,
      usage: 'Add &confirm=yes to apply'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return new Response(JSON.stringify({ error: 'Service account not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', releaseId, {
      submitterId: newOwnerId,
      uploadedBy: newOwnerId,
      userId: newOwnerId,
      updatedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Updated release ${releaseId} - submitterId/uploadedBy/userId set to ${newOwnerId}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
