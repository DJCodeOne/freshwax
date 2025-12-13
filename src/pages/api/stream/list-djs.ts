// src/pages/api/stream/list-djs.ts
// List approved DJs who can go live
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const approvedOnly = url.searchParams.get('approved') === 'true';

  try {
    // Get DJs from djLobbyBypass collection (those granted access)
    const bypassDocs = await queryCollection('djLobbyBypass', {
      orderBy: { field: 'grantedAt', direction: 'DESCENDING' },
      limit: 50
    });

    const djs = await Promise.all(bypassDocs.map(async (doc) => {
      const data = doc;
      const userId = doc.id;

      // Get additional user info
      let djName = data.name || data.email?.split('@')[0] || 'Unknown DJ';
      let email = data.email || '';
      let lastStreamAt = null;

      // Try to get more info from users collection
      try {
        const userDoc = await getDocument('users', userId);
        if (userDoc) {
          djName = userDoc.displayName || userDoc.name || djName;
          email = userDoc.email || email;
        }
      } catch (e) {
        // Ignore
      }

      // Try to get last stream
      try {
        const streamsSnapshot = await queryCollection('livestreams', {
          filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
          orderBy: { field: 'startedAt', direction: 'DESCENDING' },
          limit: 1
        });

        if (streamsSnapshot.length > 0) {
          const streamData = streamsSnapshot[0];
          lastStreamAt = streamData.startedAt instanceof Date
            ? streamData.startedAt.toISOString()
            : streamData.startedAt || null;
        }
      } catch (e) {
        // Ignore - might not have index
      }

      return {
        userId,
        djName,
        email,
        grantedAt: data.grantedAt instanceof Date
          ? data.grantedAt.toISOString()
          : data.grantedAt || null,
        reason: data.reason || null,
        lastStreamAt,
        // Placeholder values for Icecast integration
        icecastMountPoint: `/live/${userId.substring(0, 8)}`,
        twitchChannel: null
      };
    }));

    return new Response(JSON.stringify({
      success: true,
      djs
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[list-djs] Error:', error);
    return new Response(JSON.stringify({
      success: true,
      djs: [],
      error: error.message
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
