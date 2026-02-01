// src/pages/api/admin/update-release-field.ts
// Update a specific field on a release

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');
  const field = url.searchParams.get('field');
  const value = url.searchParams.get('value');
  const confirm = url.searchParams.get('confirm');

  if (!releaseId || !field) {
    return new Response(JSON.stringify({
      error: 'Missing releaseId or field',
      usage: '/api/admin/update-release-field?releaseId=xxx&field=pricing.digital&value=0&confirm=yes'
    }), {
      status: 400,
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

  // Parse value
  let parsedValue: any = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (value === 'null') parsedValue = null;
  else if (value?.startsWith('{') || value?.startsWith('[')) {
    try { parsedValue = JSON.parse(value); } catch { /* keep as string */ }
  }
  else if (!isNaN(Number(value))) parsedValue = Number(value);

  if (confirm !== 'yes') {
    return new Response(JSON.stringify({
      message: 'Preview of field update',
      releaseId,
      field,
      newValue: parsedValue,
      valueType: typeof parsedValue,
      usage: 'Add &confirm=yes to apply'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', releaseId, {
      [field]: parsedValue
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${field} to ${parsedValue}`,
      releaseId,
      field,
      newValue: parsedValue
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
