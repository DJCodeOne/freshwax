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

  // Run all health checks in parallel — D1, R2, KV, and Firebase are fully independent
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  const checkD1 = async (): Promise<CheckResult> => {
    const db = env?.DB;
    if (!db) return { ok: false, latency_ms: 0, error: 'DB binding not available' };
    const start = Date.now();
    await db.prepare('SELECT 1').first();
    return { ok: true, latency_ms: Date.now() - start };
  };

  const checkR2 = async (): Promise<CheckResult> => {
    const r2 = env?.R2;
    if (!r2) return { ok: false, latency_ms: 0, error: 'R2 binding not available' };
    const start = Date.now();
    await r2.head('healthcheck-probe');
    return { ok: true, latency_ms: Date.now() - start };
  };

  const checkKV = async (): Promise<CheckResult> => {
    const kv = env?.CACHE;
    if (!kv) return { ok: false, latency_ms: 0, error: 'KV binding not available' };
    const start = Date.now();
    await kv.get('health-check-probe');
    return { ok: true, latency_ms: Date.now() - start };
  };

  const checkFirebase = async (): Promise<CheckResult> => {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases?pageSize=1`;
    const start = Date.now();
    const res = await fetchWithTimeout(firestoreUrl, {}, 5000);
    const latency = Date.now() - start;
    if (res.ok || res.status === 401 || res.status === 403) {
      // 401/403 means Firestore is reachable but auth required — connectivity is fine
      return { ok: true, latency_ms: latency };
    }
    return { ok: false, latency_ms: latency, error: `HTTP ${res.status}` };
  };

  const [d1Result, r2Result, kvResult, firebaseResult] = await Promise.allSettled([
    checkD1(),
    checkR2(),
    checkKV(),
    checkFirebase()
  ]);

  const toCheckResult = (settled: PromiseSettledResult<CheckResult>, fallbackError: string): CheckResult =>
    settled.status === 'fulfilled'
      ? settled.value
      : { ok: false, latency_ms: 0, error: settled.reason instanceof Error ? settled.reason.message : fallbackError };

  const checks: Record<string, CheckResult> = {
    d1: toCheckResult(d1Result, 'D1 query failed'),
    r2: toCheckResult(r2Result, 'R2 head failed'),
    kv: toCheckResult(kvResult, 'KV get failed'),
    firebase: toCheckResult(firebaseResult, 'Firestore probe failed'),
  };

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
