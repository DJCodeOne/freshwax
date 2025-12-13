// src/pages/api/fix-release-status.js
// One-time script to set all releases to status: 'live'

import { queryCollection, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest.js';

export const prerender = false;

export async function GET() {
  // Initialize Firebase env for write operations
  initFirebaseEnv(import.meta.env);

  try {
    const releases = await queryCollection('releases', {});

    const updates = [];

    for (const release of releases) {
      // Update if status is not 'live'
      if (release.status !== 'live') {
        await updateDocument('releases', release.id, {
          status: 'live',
          published: true,
          approved: true,
          updatedAt: new Date().toISOString()
        });

        updates.push({
          id: release.id,
          oldStatus: release.status,
          newStatus: 'live'
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${updates.length} releases to status: 'live'`,
      updates: updates
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
