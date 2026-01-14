// src/pages/api/admin/fix-release-owner.ts
// Fix release submittedBy field to link to correct artist

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
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
    private_key: privateKey.replace(/\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    const body = await request.json();
    const { releaseId, newOwnerId } = body;

    if (!releaseId || !newOwnerId) {
      return new Response(JSON.stringify({
        error: 'Missing releaseId or newOwnerId',
        usage: 'POST { releaseId: "xxx", newOwnerId: "partnerId" }'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the release to verify it exists
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return new Response(JSON.stringify({ error: 'Release not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the artist to verify they exist
    const artist = await getDocument('artists', newOwnerId);
    if (!artist) {
      return new Response(JSON.stringify({ error: 'Artist not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update the release
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', releaseId, {
      submittedBy: newOwnerId,
      artistId: newOwnerId,
      updatedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Release owner updated',
      release: {
        id: releaseId,
        title: release.releaseName || release.title,
        previousOwner: release.submittedBy || '(none)',
        newOwner: newOwnerId,
        artistName: artist.artistName || artist.name
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[fix-release-owner] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
