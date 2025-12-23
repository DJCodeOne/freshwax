import type { APIRoute } from 'astro';

// Viewer info structure
interface ViewerInfo {
  sessionId: string;
  lastSeen: number;
  userId?: string;
  userName?: string;
  userAvatar?: string;
}

// In-memory viewer tracking
// Map structure: streamId -> Map<sessionId, ViewerInfo>
const viewers = new Map<string, Map<string, ViewerInfo>>();

const SESSION_TIMEOUT = 60000; // 60 seconds - expire if no heartbeat

// Clean up stale sessions and return active viewers
function cleanupStaleSessions(streamId: string): ViewerInfo[] {
  const streamViewers = viewers.get(streamId);
  if (!streamViewers) return [];

  const now = Date.now();
  const activeViewers: ViewerInfo[] = [];

  for (const [sessionId, viewer] of streamViewers) {
    if (now - viewer.lastSeen > SESSION_TIMEOUT) {
      streamViewers.delete(sessionId);
    } else {
      activeViewers.push(viewer);
    }
  }

  // Clean up empty stream entries
  if (streamViewers.size === 0) {
    viewers.delete(streamId);
  }

  return activeViewers;
}

// Get viewer count for a stream
function getViewerCount(streamId: string): number {
  return cleanupStaleSessions(streamId).length;
}

// Get list of online users (logged-in viewers only)
function getOnlineUsers(streamId: string): { id: string; name: string; avatar: string | null }[] {
  const activeViewers = cleanupStaleSessions(streamId);

  // Filter to logged-in users only, dedupe by userId
  const userMap = new Map<string, { id: string; name: string; avatar: string | null }>();

  for (const viewer of activeViewers) {
    if (viewer.userId && viewer.userName) {
      userMap.set(viewer.userId, {
        id: viewer.userId,
        name: viewer.userName,
        avatar: viewer.userAvatar || null
      });
    }
  }

  return Array.from(userMap.values());
}

// Register/update a viewer heartbeat
function registerHeartbeat(
  streamId: string,
  sessionId: string,
  userId?: string,
  userName?: string,
  userAvatar?: string
): number {
  if (!viewers.has(streamId)) {
    viewers.set(streamId, new Map());
  }

  const streamViewers = viewers.get(streamId)!;
  streamViewers.set(sessionId, {
    sessionId,
    lastSeen: Date.now(),
    userId,
    userName,
    userAvatar
  });

  // Cleanup and return count
  return cleanupStaleSessions(streamId).length;
}

// Remove a viewer (on page unload)
function removeViewer(streamId: string, sessionId: string): number {
  const streamViewers = viewers.get(streamId);
  if (streamViewers) {
    streamViewers.delete(sessionId);
  }
  return cleanupStaleSessions(streamId).length;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { streamId, sessionId, action, userId, userName, userAvatar } = body;

    if (!streamId || !sessionId) {
      return new Response(JSON.stringify({ error: 'Missing streamId or sessionId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let count: number;
    let onlineUsers: { id: string; name: string; avatar: string | null }[] = [];

    if (action === 'leave') {
      count = removeViewer(streamId, sessionId);
    } else {
      count = registerHeartbeat(streamId, sessionId, userId, userName, userAvatar);
    }

    // Always return the list of online users
    onlineUsers = getOnlineUsers(streamId);

    return new Response(JSON.stringify({ count, onlineUsers }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const GET: APIRoute = async ({ url }) => {
  const streamId = url.searchParams.get('streamId');

  if (!streamId) {
    return new Response(JSON.stringify({ error: 'Missing streamId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const count = getViewerCount(streamId);
  const onlineUsers = getOnlineUsers(streamId);

  return new Response(JSON.stringify({ count, onlineUsers }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
};
