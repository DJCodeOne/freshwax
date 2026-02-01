// src/pages/api/admin/check-release.ts
// Check release submitter info

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const search = url.searchParams.get('search') || 'ultron';

  const runtimeEnv = (locals as any)?.runtime?.env;
  initFirebaseEnv(runtimeEnv);

  try {
    const releases = await queryCollection('releases', { limit: 100, skipCache: true });

    // Find releases matching search
    const matches = releases.filter((r: any) =>
      (r.title || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.artistName || '').toLowerCase().includes(search.toLowerCase())
    );

    const details = matches.map((r: any) => ({
      id: r.id,
      title: r.title,
      artistName: r.artistName,
      submitterId: r.submitterId,
      uploadedBy: r.uploadedBy,
      userId: r.userId,
      email: r.email,
      submitterEmail: r.submitterEmail,
      labelName: r.labelName,
      // Show all fields that might indicate owner
      allOwnerFields: {
        submitterId: r.submitterId,
        uploadedBy: r.uploadedBy,
        userId: r.userId,
        submittedBy: r.submittedBy,
        createdBy: r.createdBy,
        ownerId: r.ownerId
      }
    }));

    // Also look up artists/users to find y2
    const artists = await queryCollection('artists', { limit: 100, skipCache: true });
    const y2Artist = artists.filter((a: any) =>
      (a.name || '').toLowerCase().includes('y2') ||
      (a.displayName || '').toLowerCase().includes('y2')
    );

    return new Response(JSON.stringify({
      success: true,
      searchTerm: search,
      matchingReleases: details,
      y2Artists: y2Artist.map((a: any) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        email: a.email,
        userId: a.userId
      }))
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
