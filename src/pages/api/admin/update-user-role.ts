// src/pages/api/admin/update-user-role.ts
// Update user roles in the users collection

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saGetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const role = url.searchParams.get('role');
  const value = url.searchParams.get('value');
  const confirm = url.searchParams.get('confirm');

  if (!userId || !role) {
    return new Response(JSON.stringify({
      error: 'Missing userId or role',
      usage: '/api/admin/update-user-role?userId=xxx&role=artist&value=false&confirm=yes'
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

  try {
    // Get current user document
    const user = await saGetDocument(serviceAccountKey, projectId, 'users', userId);

    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found', userId }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const currentRoles = user.roles || {};
    const newValue = value === 'true' || value === '1';

    if (confirm !== 'yes') {
      return new Response(JSON.stringify({
        message: 'Preview of role change',
        userId,
        email: user.email,
        displayName: user.displayName,
        currentRoles,
        change: {
          role,
          from: currentRoles[role],
          to: newValue
        },
        usage: 'Add &confirm=yes to apply'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Apply the update
    await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, {
      [`roles.${role}`]: newValue
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${role} role to ${newValue}`,
      userId,
      email: user.email,
      previousValue: currentRoles[role],
      newValue
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
