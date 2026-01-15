// src/pages/api/admin/check-releases.ts
// Diagnostic endpoint to check release ownership fields

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

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
    const releases = await saQueryCollection(serviceAccountKey, projectId, 'releases', {
      limit: 100
    });

    const summary = releases.map((r: any) => ({
      id: r.id,
      artistName: r.artistName || r.artist,
      releaseName: r.releaseName || r.title,
      submitterEmail: r.submitterEmail || r.email || 'NOT SET',
      submitterId: r.submitterId || 'NOT SET',
      uploadedBy: r.uploadedBy || 'NOT SET',
      userId: r.userId || 'NOT SET',
      status: r.status
    }));

    // If userId provided, check which would match
    let matchesForUser = null;
    if (userId) {
      matchesForUser = {
        bySubmitterId: releases.filter((r: any) => r.submitterId === userId).length,
        byUploadedBy: releases.filter((r: any) => r.uploadedBy === userId).length,
        byUserId: releases.filter((r: any) => r.userId === userId).length,
        totalMatches: releases.filter((r: any) =>
          r.submitterId === userId || r.uploadedBy === userId || r.userId === userId
        ).map((r: any) => r.releaseName || r.title)
      };
    }

    return new Response(JSON.stringify({
      totalReleases: releases.length,
      releases: summary,
      matchesForUser
    }, null, 2), {
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
