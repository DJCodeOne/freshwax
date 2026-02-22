import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('livestream/heartbeat');
import { z } from 'zod';

const HeartbeatSchema = z.object({
  streamId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  action: z.string().max(50).nullish(),
  userName: z.string().max(200).nullish(),
  userAvatar: z.string().max(2000).nullish(),
}).passthrough();

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
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`heartbeat:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = HeartbeatSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const body = parseResult.data;
    const { streamId, sessionId, action } = body;

    // SECURITY: Only use user info from verified auth, not from body
    // This prevents spoofing usernames/avatars in the online users list
    let userId: string | undefined;
    let userName: string | undefined;
    let userAvatar: string | undefined;
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyRequestUser } = await import('../../../lib/firebase-rest');
        const { userId: verifiedId, email } = await verifyRequestUser(request);
        if (verifiedId) {
          userId = verifiedId;
          userName = body.userName; // Allow display name from body only when auth is verified
          userAvatar = body.userAvatar;
        }
      } catch { /* no auth = anonymous viewer, still count them */ }
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

    return jsonResponse({ count, onlineUsers }, 200, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    log.error('Heartbeat error:', error);
    return ApiErrors.serverError('Server error');
  }
};

export const GET: APIRoute = async ({ request, url }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rl = checkRateLimit(`heartbeat:${clientId}`, RateLimiters.standard);
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter!);
  }

  const streamId = url.searchParams.get('streamId');

  if (!streamId) {
    return ApiErrors.badRequest('Missing streamId');
  }

  const count = getViewerCount(streamId);
  const onlineUsers = getOnlineUsers(streamId);

  return jsonResponse({ count, onlineUsers }, 200, { headers: { 'Cache-Control': 'no-store' } });
};
