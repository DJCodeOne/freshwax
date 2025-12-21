// src/pages/api/admin/health-check.ts
// Real-time health check for all services
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';

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
    hlsUrl?: string;
  } | null;
}

// Check Firebase connectivity
async function checkFirebase(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/system/health?key=${import.meta.env.PUBLIC_FIREBASE_API_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const latency = Date.now() - start;

    if (response.ok || response.status === 404) {
      return { name: 'Firebase', status: 'ok', latency, lastChecked: new Date().toISOString() };
    }
    return { name: 'Firebase', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: any) {
    return { name: 'Firebase', status: 'error', message: e.message || 'Connection failed', lastChecked: new Date().toISOString() };
  }
}

// Check R2/CDN connectivity
async function checkR2(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const response = await fetch('https://cdn.freshwax.co.uk/health-check.txt', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    const latency = Date.now() - start;

    if (response.ok || response.status === 404) {
      return { name: 'R2 Storage', status: 'ok', latency, lastChecked: new Date().toISOString() };
    }
    return { name: 'R2 Storage', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: any) {
    return { name: 'R2 Storage', status: 'error', message: e.message || 'Connection failed', lastChecked: new Date().toISOString() };
  }
}

// Check Stripe API
async function checkStripe(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    // Just check if Stripe's API is reachable (public endpoint)
    const response = await fetch('https://api.stripe.com/v1/', {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    const latency = Date.now() - start;

    // Stripe returns 401/404 without auth, which means it's reachable
    if (response.status === 401 || response.status === 404 || response.ok) {
      return { name: 'Stripe', status: 'ok', latency, lastChecked: new Date().toISOString() };
    }
    return { name: 'Stripe', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: any) {
    return { name: 'Stripe', status: 'error', message: e.message || 'Connection failed', lastChecked: new Date().toISOString() };
  }
}

// Check MediaMTX/Streaming server
async function checkStreaming(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    // Check the HLS endpoint
    const response = await fetch('https://live.freshwax.co.uk/freshwax-main/index.m3u8', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    const latency = Date.now() - start;

    // 404 means server is up but no stream, 200 means stream active
    if (response.ok) {
      return { name: 'Stream Server', status: 'ok', latency, message: 'Stream active', lastChecked: new Date().toISOString() };
    }
    if (response.status === 404) {
      return { name: 'Stream Server', status: 'ok', latency, message: 'No active stream', lastChecked: new Date().toISOString() };
    }
    return { name: 'Stream Server', status: 'warning', latency, message: `HTTP ${response.status}`, lastChecked: new Date().toISOString() };
  } catch (e: any) {
    // Streaming server might be offline or tunnel not running
    return { name: 'Stream Server', status: 'warning', message: 'Server offline or unreachable', lastChecked: new Date().toISOString() };
  }
}

// Get active livestream info
async function getLivestreamInfo(): Promise<HealthCheckResponse['livestream']> {
  try {
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/livestreamSlots?key=${import.meta.env.PUBLIC_FIREBASE_API_KEY}`,
      { signal: AbortSignal.timeout(5000) }
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
          duration,
          hlsUrl: fields.hlsUrl?.stringValue || 'https://live.freshwax.co.uk/freshwax-main/index.m3u8'
        };
      }
    }

    return { isLive: false };
  } catch (e) {
    return null;
  }
}

// Get quick stats
async function getQuickStats(): Promise<HealthCheckResponse['stats']> {
  try {
    // Get orders from today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ordersResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/orders?key=${import.meta.env.PUBLIC_FIREBASE_API_KEY}&pageSize=100`,
      { signal: AbortSignal.timeout(5000) }
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
  } catch (e) {
    return {};
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Require admin authentication
  const authError = requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const timestamp = new Date().toISOString();

  // Run all health checks in parallel
  const [firebase, r2, stripe, streaming, livestream, stats] = await Promise.all([
    checkFirebase(),
    checkR2(),
    checkStripe(),
    checkStreaming(),
    getLivestreamInfo(),
    getQuickStats()
  ]);

  const services = [firebase, r2, stripe, streaming];

  const response: HealthCheckResponse = {
    success: true,
    timestamp,
    services,
    stats: stats || {},
    livestream
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0'
    }
  });
};
