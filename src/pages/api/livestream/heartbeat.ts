import type { APIRoute } from 'astro';

// In-memory viewer tracking
// Map structure: streamId -> Map<sessionId, lastSeen timestamp>
const viewers = new Map<string, Map<string, number>>();

const SESSION_TIMEOUT = 60000; // 60 seconds - expire if no heartbeat

// Clean up stale sessions
function cleanupStaleSessions(streamId: string): number {
  const streamViewers = viewers.get(streamId);
  if (!streamViewers) return 0;
  
  const now = Date.now();
  let removed = 0;
  
  for (const [sessionId, lastSeen] of streamViewers) {
    if (now - lastSeen > SESSION_TIMEOUT) {
      streamViewers.delete(sessionId);
      removed++;
    }
  }
  
  // Clean up empty stream entries
  if (streamViewers.size === 0) {
    viewers.delete(streamId);
  }
  
  return streamViewers?.size || 0;
}

// Get viewer count for a stream
function getViewerCount(streamId: string): number {
  return cleanupStaleSessions(streamId);
}

// Register/update a viewer heartbeat
function registerHeartbeat(streamId: string, sessionId: string): number {
  if (!viewers.has(streamId)) {
    viewers.set(streamId, new Map());
  }
  
  const streamViewers = viewers.get(streamId)!;
  streamViewers.set(sessionId, Date.now());
  
  // Cleanup and return count
  return cleanupStaleSessions(streamId);
}

// Remove a viewer (on page unload)
function removeViewer(streamId: string, sessionId: string): number {
  const streamViewers = viewers.get(streamId);
  if (streamViewers) {
    streamViewers.delete(sessionId);
  }
  return cleanupStaleSessions(streamId);
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { streamId, sessionId, action } = body;
    
    if (!streamId || !sessionId) {
      return new Response(JSON.stringify({ error: 'Missing streamId or sessionId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    let count: number;
    
    if (action === 'leave') {
      count = removeViewer(streamId, sessionId);
    } else {
      count = registerHeartbeat(streamId, sessionId);
    }
    
    return new Response(JSON.stringify({ count }), {
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
  
  return new Response(JSON.stringify({ count }), {
    status: 200,
    headers: { 
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
};
