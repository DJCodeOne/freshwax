// src/pages/api/admin/health-check.ts
// Real-time health check for all services
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, jsonResponse } from '../../../lib/api-utils';
import { TIMEOUTS } from '../../../lib/timeouts';

export const prerender = false;

interface ServiceStatus {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'unknown';
  latency?: number;
  message?: string;
  lastChecked: string;
}

interface HealthCheckResponse {
  success: boolean;
  timestamp: string;
  services: ServiceStatus[];
  stats: {
    totalUsers24h?: number;
    ordersToday?: number;
    revenueToday?: number;
    activeDJs?: number;
    mixPlaysToday?: number;
  };
  livestream: {
    isLive: boolean;
    djName?: string;
    title?: string;
    viewers?: number;
    duration?: number;
  } | null;
}

// Check Firebase connectivity
async function checkFirebase(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    // Use releases collection (public) to verify Firebase is reachable
    const response = await fetchWithTimeout(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/releases?pageSize=1&key=${import.meta.env.PUBLIC_FIREBASE_API_KEY}`,
      {},
      5000
    );
    const latency = Date.now() - start;

    if (response.ok) {
      return { name: 'Firebase', status: 'ok', latency, lastChecked: new Date().toISOString() };
    }
    return { name: 'Firebase', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: unknown) {
    return { name: 'Firebase', status: 'error', message: 'Connection failed', lastChecked: new Date().toISOString() };
  }
}

// Check R2/CDN connectivity
async function checkR2(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const response = await fetchWithTimeout('https://cdn.freshwax.co.uk/health-check.txt', {
      method: 'HEAD'
    }, 5000);
    const latency = Date.now() - start;

    if (response.ok || response.status === 404) {
      return { name: 'R2 Storage', status: 'ok', latency, lastChecked: new Date().toISOString() };
    }
    return { name: 'R2 Storage', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: unknown) {
    return { name: 'R2 Storage', status: 'error', message: 'Connection failed', lastChecked: new Date().toISOString() };
  }
}

// Check Stripe API
async function checkStripe(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    // Just check if Stripe's API is reachable (public endpoint)
    const response = await fetchWithTimeout('https://api.stripe.com/v1/', {
      method: 'GET'
    }, 5000);
    const latency = Date.now() - start;

    // Stripe returns 401/404 without auth, which means it's reachable
    if (response.status === 401 || response.status === 404 || response.ok) {
      return { name: 'Stripe', status: 'ok', latency, lastChecked: new Date().toISOString() };
    }
    return { name: 'Stripe', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: unknown) {
    return { name: 'Stripe', status: 'error', message: 'Connection failed', lastChecked: new Date().toISOString() };
  }
}

// Check Playlist server
async function checkPlaylist(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const token = import.meta.env.PLAYLIST_ACCESS_TOKEN || '';
    const response = await fetchWithTimeout('https://playlist.freshwax.co.uk/health', {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    }, 5000);
    const latency = Date.now() - start;

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return { name: 'Playlist Server', status: 'ok', latency, message: data.trackCount ? `${data.trackCount} tracks` : undefined, lastChecked: new Date().toISOString() };
    }
    // 401 means server is up but we lack auth
    if (response.status === 401 || response.status === 403) {
      return { name: 'Playlist Server', status: 'ok', latency, message: 'Online (auth required)', lastChecked: new Date().toISOString() };
    }
    return { name: 'Playlist Server', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: unknown) {
    return { name: 'Playlist Server', status: 'warning', message: 'Server offline or unreachable', lastChecked: new Date().toISOString() };
  }
}

// Check Icecast relay server
async function checkIcecast(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const response = await fetchWithTimeout('https://icecast.freshwax.co.uk/status-json.xsl', {}, TIMEOUTS.SHORT);
    const latency = Date.now() - start;

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const sources = data.icestats?.source;
      const mountCount = Array.isArray(sources) ? sources.length : (sources ? 1 : 0);
      return { name: 'Icecast', status: 'ok', latency, message: `${mountCount} mount(s)`, lastChecked: new Date().toISOString() };
    }
    if (response.status === 401 || response.status === 403 || response.status === 400) {
      return { name: 'Icecast', status: 'ok', latency, message: 'Online', lastChecked: new Date().toISOString() };
    }
    return { name: 'Icecast', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: unknown) {
    return { name: 'Icecast', status: 'warning', message: 'Server offline or unreachable', lastChecked: new Date().toISOString() };
  }
}

// Check MediaMTX/Streaming server
async function checkStreaming(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    // Check the MediaMTX API endpoint (more reliable than HLS)
    const response = await fetchWithTimeout('https://stream.freshwax.co.uk/v3/paths/list', {
      method: 'GET'
    }, 5000);
    const latency = Date.now() - start;

    if (response.ok) {
      const data = await response.json();
      const activePaths = (data.items || []).filter((p: Record<string, unknown>) => p.ready);
      const message = activePaths.length > 0
        ? `${activePaths.length} active stream(s)`
        : 'Online, no active streams';
      return { name: 'Stream Server', status: 'ok', latency, message, lastChecked: new Date().toISOString() };
    }
    return { name: 'Stream Server', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: unknown) {
    // Streaming server might be offline or tunnel not running
    return { name: 'Stream Server', status: 'warning', message: 'Server offline or unreachable', lastChecked: new Date().toISOString() };
  }
}

// Get active livestream info
async function getLivestreamInfo(): Promise<HealthCheckResponse['livestream']> {
  try {
    const response = await fetchWithTimeout(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/livestreamSlots?key=${import.meta.env.PUBLIC_FIREBASE_API_KEY}`,
      {},
      5000
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.documents) return null;

    // Find active stream
    for (const doc of data.documents) {
      const fields = doc.fields || {};
      const status = fields.status?.stringValue;

      if (status === 'live') {
        const startTime = fields.startTime?.timestampValue ? new Date(fields.startTime.timestampValue) : null;
        const duration = startTime ? Math.floor((Date.now() - startTime.getTime()) / 1000) : 0;

        return {
          isLive: true,
          djName: fields.djName?.stringValue || fields.displayName?.stringValue || 'Unknown DJ',
          title: fields.title?.stringValue || 'Live Session',
          viewers: parseInt(fields.currentViewers?.integerValue || '0'),
          duration
        };
      }
    }

    return { isLive: false };
  } catch (e: unknown) {
    return null;
  }
}

// Get quick stats
async function getQuickStats(): Promise<HealthCheckResponse['stats']> {
  try {
    // Get orders from today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ordersResponse = await fetchWithTimeout(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/orders?key=${import.meta.env.PUBLIC_FIREBASE_API_KEY}&pageSize=100`,
      {},
      5000
    );

    let ordersToday = 0;
    let revenueToday = 0;

    if (ordersResponse.ok) {
      const ordersData = await ordersResponse.json();
      if (ordersData.documents) {
        for (const doc of ordersData.documents) {
          const fields = doc.fields || {};
          const createdAt = fields.createdAt?.timestampValue ? new Date(fields.createdAt.timestampValue) : null;

          if (createdAt && createdAt >= today) {
            ordersToday++;
            revenueToday += parseFloat(fields.total?.doubleValue || fields.total?.integerValue || '0');
          }
        }
      }
    }

    return {
      ordersToday,
      revenueToday
    };
  } catch (e: unknown) {
    return {};
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`health-check:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const timestamp = new Date().toISOString();

  // D1 connectivity check
  const db = locals.runtime?.env?.DB as D1Database | undefined;
  const d1Check: Promise<ServiceStatus> = db
    ? (async () => {
        const start = Date.now();
        try {
          await db.prepare('SELECT 1 as ok').first();
          const latency = Date.now() - start;
          return { name: 'D1 Database', status: 'ok' as const, latency, lastChecked: new Date().toISOString() };
        } catch (error: unknown) {
          return { name: 'D1 Database', status: 'error' as const, message: error instanceof Error ? error.message : 'D1 unreachable', lastChecked: new Date().toISOString() };
        }
      })()
    : Promise.resolve({ name: 'D1 Database', status: 'error' as const, message: 'D1 binding not available', lastChecked: new Date().toISOString() });

  // Run all health checks in parallel — use allSettled so one timeout doesn't kill all
  const settled = await Promise.allSettled([
    checkFirebase(),
    checkR2(),
    checkStripe(),
    checkStreaming(),
    checkPlaylist(),
    checkIcecast(),
    d1Check,
    getLivestreamInfo(),
    getQuickStats()
  ]);

  const fallbackService = (name: string): ServiceStatus => ({
    name,
    status: 'error' as const,
    message: 'Health check timed out or threw',
    lastChecked: new Date().toISOString()
  });

  const firebase = settled[0].status === 'fulfilled' ? settled[0].value : fallbackService('Firebase');
  const r2 = settled[1].status === 'fulfilled' ? settled[1].value : fallbackService('R2 Storage');
  const stripe = settled[2].status === 'fulfilled' ? settled[2].value : fallbackService('Stripe');
  const streaming = settled[3].status === 'fulfilled' ? settled[3].value : fallbackService('Streaming');
  const playlist = settled[4].status === 'fulfilled' ? settled[4].value : fallbackService('Playlist');
  const icecast = settled[5].status === 'fulfilled' ? settled[5].value : fallbackService('Icecast');
  const d1 = settled[6].status === 'fulfilled' ? settled[6].value : fallbackService('D1 Database');
  const livestream = settled[7].status === 'fulfilled' ? settled[7].value : null;
  const stats = settled[8].status === 'fulfilled' ? settled[8].value : null;

  const services = [firebase, r2, stripe, d1, streaming, playlist, icecast];

  const response: HealthCheckResponse = {
    success: true,
    timestamp,
    services,
    stats: stats || {},
    livestream
  };

  return jsonResponse(response);
};
