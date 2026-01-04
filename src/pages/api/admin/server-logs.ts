// src/pages/api/admin/server-logs.ts
// Get server logs (placeholder - actual logs would come from server)
import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase and admin config
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`server-logs:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // SECURITY: Require admin authentication via header
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    // Since we can't directly access MediaMTX logs from Cloudflare,
    // we return recent activity from Firebase as a log
    const logs: string[] = [];
    const now = new Date();

    logs.push(`=== Fresh Wax Server Logs ===`);
    logs.push(`Generated: ${now.toISOString()}`);
    logs.push(`---`);

    // Get recent livestream activity
    try {
      const streams = await queryCollection('livestreams', { limit: 10 });
      logs.push(`\n[LIVESTREAM ACTIVITY]`);

      if (streams.length === 0) {
        logs.push('  No recent streams');
      } else {
        streams.forEach((s: any) => {
          const status = s.status || 'unknown';
          const dj = s.djName || 'Unknown DJ';
          const started = s.startedAt ? new Date(s.startedAt).toISOString() : 'N/A';
          logs.push(`  [${status.toUpperCase()}] ${dj} - Started: ${started}`);
        });
      }
    } catch (e) {
      logs.push(`  Error fetching livestreams: ${e}`);
    }

    // Get recent slot activity
    try {
      const slots = await queryCollection('livestreamSlots', { limit: 10 });
      logs.push(`\n[SLOT ACTIVITY]`);

      if (slots.length === 0) {
        logs.push('  No recent slots');
      } else {
        slots.forEach((s: any) => {
          const status = s.status || 'unknown';
          const dj = s.djName || 'Unknown DJ';
          logs.push(`  [${status.toUpperCase()}] ${dj} - ${s.id}`);
        });
      }
    } catch (e) {
      logs.push(`  Error fetching slots: ${e}`);
    }

    // Get recent bypass requests
    try {
      const requests = await queryCollection('bypassRequests', { limit: 5 });
      logs.push(`\n[BYPASS REQUESTS]`);

      if (requests.length === 0) {
        logs.push('  No recent requests');
      } else {
        requests.forEach((r: any) => {
          const status = r.status || 'pending';
          const user = r.userName || r.userEmail || 'Unknown';
          const created = r.createdAt ? new Date(r.createdAt).toISOString() : 'N/A';
          logs.push(`  [${status.toUpperCase()}] ${user} - ${created}`);
        });
      }
    } catch (e) {
      logs.push(`  Error fetching requests: ${e}`);
    }

    // Service status
    logs.push(`\n[SERVICE STATUS]`);
    logs.push(`  Firebase: Connected`);
    logs.push(`  Stream Server: Check /api/admin/server-status`);
    logs.push(`  CDN: Cloudflare Pages`);

    logs.push(`\n--- End of Logs ---`);

    return new Response(JSON.stringify({
      logs: logs.join('\n'),
      timestamp: now.toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[ServerLogs] Error:', error);
    return new Response(JSON.stringify({
      logs: `Error fetching logs: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error: true
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
