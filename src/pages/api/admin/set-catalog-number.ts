// src/pages/api/admin/set-catalog-number.ts
// Set catalog number on a release

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');
  const releaseName = url.searchParams.get('releaseName');
  const catalogNumber = url.searchParams.get('catalogNumber');
  const confirm = url.searchParams.get('confirm');

  if (!catalogNumber) {
    return new Response(JSON.stringify({
      error: 'Missing catalogNumber',
      usage: '/api/admin/set-catalog-number?releaseId=xxx&catalogNumber=ULR001&confirm=yes',
      altUsage: '/api/admin/set-catalog-number?releaseName=Curiosity&catalogNumber=ULR001&confirm=yes'
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
    let targetReleaseId = releaseId;

    // If no releaseId, search by name
    if (!targetReleaseId && releaseName) {
      const releases = await saQueryCollection(serviceAccountKey, projectId, 'releases', {
        limit: 100
      });

      const found = releases.find((r: any) =>
        r.releaseName?.toLowerCase().includes(releaseName.toLowerCase())
      );

      if (!found) {
        return new Response(JSON.stringify({
          error: `No release found matching "${releaseName}"`,
          availableReleases: releases.map((r: any) => ({
            id: r.id,
            releaseName: r.releaseName,
            artistName: r.artistName,
            currentCatalogNumber: r.catalogNumber || r.labelCode || '(none)'
          }))
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      targetReleaseId = found.id;
    }

    if (!targetReleaseId) {
      return new Response(JSON.stringify({
        error: 'Must provide releaseId or releaseName'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get current release data
    const releases = await saQueryCollection(serviceAccountKey, projectId, 'releases', {
      limit: 100
    });
    const release = releases.find((r: any) => r.id === targetReleaseId);

    if (!release) {
      return new Response(JSON.stringify({ error: 'Release not found', releaseId: targetReleaseId }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (confirm !== 'yes') {
      return new Response(JSON.stringify({
        message: 'Preview of catalog number update',
        releaseId: targetReleaseId,
        releaseName: release.releaseName,
        artistName: release.artistName,
        currentCatalogNumber: release.catalogNumber || '(none)',
        currentLabelCode: release.labelCode || '(none)',
        newCatalogNumber: catalogNumber,
        usage: 'Add &confirm=yes to apply'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Apply the update
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', targetReleaseId, {
      catalogNumber: catalogNumber
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Set catalogNumber to "${catalogNumber}"`,
      releaseId: targetReleaseId,
      releaseName: release.releaseName
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
