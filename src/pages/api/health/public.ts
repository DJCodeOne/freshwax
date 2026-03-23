// src/pages/api/health/public.ts
// Public health endpoint for uptime monitoring (Pingdom, UptimeRobot, etc.)
// No auth required. Checks D1, KV, and R2 connectivity.
// For detailed service checks with latency data, see /api/health/ (admin-only)
import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../lib/api-utils';

export const prerender = false;

interface ServiceCheck {
  ok: boolean;
  error?: string;
}

export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime?.env;
  const checks: Record<string, ServiceCheck> = {};

  // D1: lightweight SELECT 1
  try {
    const db = env?.DB;
    if (!db) {
      checks.d1 = { ok: false, error: 'binding unavailable' };
    } else {
      await db.prepare('SELECT 1').first();
      checks.d1 = { ok: true };
    }
  } catch (_e: unknown) {
    checks.d1 = { ok: false, error: 'query failed' };
  }

  // KV: lightweight get (returns null for missing key — proves connectivity)
  try {
    const kv = env?.CACHE;
    if (!kv) {
      checks.kv = { ok: false, error: 'binding unavailable' };
    } else {
      await kv.get('health-check-probe');
      checks.kv = { ok: true };
    }
  } catch (_e: unknown) {
    checks.kv = { ok: false, error: 'get failed' };
  }

  // R2: lightweight head (returns null for missing key — proves connectivity)
  try {
    const r2 = env?.R2;
    if (!r2) {
      checks.r2 = { ok: false, error: 'binding unavailable' };
    } else {
      await r2.head('healthcheck-probe');
      checks.r2 = { ok: true };
    }
  } catch (_e: unknown) {
    checks.r2 = { ok: false, error: 'head failed' };
  }

  // Derive overall status
  const allOk = Object.values(checks).every(c => c.ok);
  const allDown = Object.values(checks).every(c => !c.ok);
  const status = allOk ? 'healthy' : allDown ? 'unhealthy' : 'degraded';
  const httpStatus = allOk ? 200 : 503;

  return jsonResponse({
    status,
    timestamp: new Date().toISOString(),
    checks,
  }, httpStatus, { headers: { 'Cache-Control': 'no-cache, no-store' } });
};
