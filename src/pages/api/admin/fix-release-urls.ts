// src/pages/api/admin/fix-release-urls.ts
// Update release URLs from submissions/ to releases/

import type { APIRoute } from 'astro';
import { saGetDocument, saSetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;

  // Get service account credentials from environment (individual vars or full JSON)
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  // Try full JSON first, then build from individual vars
  let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT_KEY || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountKey && clientEmail && privateKey) {
    // Build service account JSON from individual env vars
    serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'auto',
      private_key: privateKey.replace(/\\n/g, '\n'),
      client_email: clientEmail,
      client_id: '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    });
  }

  if (!serviceAccountKey) {
    return new Response(JSON.stringify({ error: 'Service account not configured - need FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY' }), { status: 500 });
  }

  try {
    const { releaseId, oldPrefix, newPrefix, createNew, releaseData, collection, docId, updateData } = await request.json();

    // Generic document update mode (for any collection)
    if (collection && docId && updateData) {
      await saUpdateDocument(serviceAccountKey, projectId, collection, docId, {
        ...updateData,
        updatedAt: new Date().toISOString()
      });
      return new Response(JSON.stringify({
        success: true,
        collection,
        docId,
        message: 'Document updated'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!releaseId) {
      return new Response(JSON.stringify({ error: 'releaseId required' }), { status: 400 });
    }

    // Create new release mode
    if (createNew && releaseData) {
      const now = new Date().toISOString();
      const newRelease = {
        ...releaseData,
        id: releaseId,
        createdAt: now,
        updatedAt: now
      };
      await saSetDocument(serviceAccountKey, projectId, 'releases', releaseId, newRelease);
      return new Response(JSON.stringify({
        success: true,
        releaseId,
        message: 'Release created'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const old = oldPrefix || 'submissions/Code_One-1765771210267';
    const newP = newPrefix || 'releases/Code_One-1765771210267';

    // Get current release using service account
    const release = await saGetDocument(serviceAccountKey, projectId, 'releases', releaseId);
    if (!release) {
      return new Response(JSON.stringify({ error: 'Release not found' }), { status: 404 });
    }

    // Function to replace URL prefix
    const fixUrl = (url: string) => {
      if (!url) return url;
      return url.replace(old, newP);
    };

    // Update artwork URLs
    const updates: any = {
      ...release,
      thumbUrl: fixUrl(release.thumbUrl),
      coverArtUrl: fixUrl(release.coverArtUrl),
      coverUrl: fixUrl(release.coverUrl),
      artworkUrl: fixUrl(release.artworkUrl),
      imageUrl: fixUrl(release.imageUrl),
      r2FolderPath: newP,
    };

    // Update track URLs
    if (release.tracks && Array.isArray(release.tracks)) {
      updates.tracks = release.tracks.map((track: any) => ({
        ...track,
        mp3Url: fixUrl(track.mp3Url),
        wavUrl: fixUrl(track.wavUrl),
        previewUrl: fixUrl(track.previewUrl),
      }));
    }

    // Save with service account auth
    await saSetDocument(serviceAccountKey, projectId, 'releases', releaseId, updates);

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      message: 'URLs updated from submissions/ to releases/'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Fix URLs error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed'
    }), { status: 500 });
  }
};
