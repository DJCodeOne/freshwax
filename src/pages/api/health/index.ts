// src/pages/api/health/index.ts
// General health check endpoint for monitoring — verifies D1, R2, KV connectivity
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { jsonResponse } from '../../../lib/api-utils';

export const prerender = false;

interface CheckResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export const GET: APIRoute = async ({ request, locals }) => {
  // SECURITY: Admin-only — exposes infrastructure details
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const requestStart = Date.now();
  const env = locals.runtime.env;

  const checks: Record<string, CheckResult> = {};

  // Check D1 database — run SELECT 1 to verify connectivity
  try {
    const db = env?.DB;
    if (db) {
      const start = Date.now();
      await db.prepare('SELECT 1').first();
      checks.d1 = { ok: true, latency_ms: Date.now() - start };
    } else {
      checks.d1 = { ok: false, latency_ms: 0, error: 'DB binding not available' };
    }
  } catch (e: unknown) {
    checks.d1 = {
      ok: false,
      latency_ms: 0,
      error: e instanceof Error ? e.message : 'D1 query failed',
    };
  }

  // Check R2 — head a non-existent key to verify bucket connectivity
  // Returns null (not found) but shouldn't throw if the binding works
  try {
    const r2 = env?.R2 || env?.BUCKET;
    if (r2) {
      const start = Date.now();
      await r2.head('healthcheck-probe');
      checks.r2 = { ok: true, latency_ms: Date.now() - start };
    } else {
      checks.r2 = { ok: false, latency_ms: 0, error: 'R2 binding not available' };
    }
  } catch (e: unknown) {
    checks.r2 = {
      ok: false,
      latency_ms: 0,
      error: e instanceof Error ? e.message : 'R2 head failed',
    };
  }

  // Check KV — get a non-existent key to verify namespace connectivity
  // Returns null (not found) but shouldn't throw if the binding works
  try {
    const kv = env?.CACHE || env?.KV;
    if (kv) {
      const start = Date.now();
      await kv.get('health-check-probe');
      checks.kv = { ok: true, latency_ms: Date.now() - start };
    } else {
      checks.kv = { ok: false, latency_ms: 0, error: 'KV binding not available' };
    }
  } catch (e: unknown) {
    checks.kv = {
      ok: false,
      latency_ms: 0,
      error: e instanceof Error ? e.message : 'KV get failed',
    };
  }

  // Derive overall status
  const allChecks = Object.values(checks);
  const failCount = allChecks.filter(c => !c.ok).length;
  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (failCount === 0) {
    status = 'healthy';
  } else if (failCount < allChecks.length) {
    status = 'degraded';
  } else {
    status = 'unhealthy';
  }

  const httpStatus = status === 'healthy' ? 200 : 503;

  return jsonResponse({
    status,
    timestamp: new Date().toISOString(),
    checks,
    uptime: `${Date.now() - requestStart}ms request time`,
  }, httpStatus, { headers: { 'Cache-Control': 'no-cache, no-store' } });
};
