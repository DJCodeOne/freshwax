// src/pages/api/health/index.ts
// General health check endpoint for monitoring — verifies D1, R2, KV, Firebase connectivity
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { jsonResponse, fetchWithTimeout } from '../../../lib/api-utils';

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

  // Check Firebase/Firestore — hit the REST discovery endpoint with a 5s timeout
  // Firebase failures mark status as degraded (not unhealthy) since it's an external dependency
  try {
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases?pageSize=1`;
    const start = Date.now();
    const res = await fetchWithTimeout(firestoreUrl, {}, 5000);
    const latency = Date.now() - start;
    if (res.ok || res.status === 401 || res.status === 403) {
      // 401/403 means Firestore is reachable but auth required — connectivity is fine
      checks.firebase = { ok: true, latency_ms: latency };
    } else {
      checks.firebase = { ok: false, latency_ms: latency, error: `HTTP ${res.status}` };
    }
  } catch (e: unknown) {
    checks.firebase = {
      ok: false,
      latency_ms: 0,
      error: e instanceof Error ? e.message : 'Firestore probe failed',
    };
  }

  // Derive overall status
  // Firebase failure only degrades, doesn't make unhealthy on its own
  const allChecks = Object.values(checks);
  const coreChecks = [checks.d1, checks.r2, checks.kv]; // infrastructure checks
  const coreFailCount = coreChecks.filter(c => !c.ok).length;
  const anyFailed = allChecks.some(c => !c.ok);
  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (!anyFailed) {
    status = 'healthy';
  } else if (coreFailCount === coreChecks.length) {
    status = 'unhealthy';
  } else {
    status = 'degraded';
  }

  const httpStatus = status === 'healthy' ? 200 : 503;

  return jsonResponse({
    status,
    timestamp: new Date().toISOString(),
    checks,
    uptime: `${Date.now() - requestStart}ms request time`,
  }, httpStatus, { headers: { 'Cache-Control': 'no-cache, no-store' } });
};
