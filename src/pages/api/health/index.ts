// src/pages/api/health/index.ts
// General health check endpoint for monitoring
import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const startTime = Date.now();
  const env = (locals as any)?.runtime?.env;

  const checks: Record<string, { ok: boolean; ms?: number }> = {};

  // Check D1 database
  try {
    const db = env?.DB;
    if (db) {
      const d1Start = Date.now();
      await db.prepare('SELECT 1').first();
      checks.d1 = { ok: true, ms: Date.now() - d1Start };
    } else {
      checks.d1 = { ok: false };
    }
  } catch {
    checks.d1 = { ok: false };
  }

  // Check KV
  try {
    const kv = env?.KV || env?.SESSION;
    if (kv) {
      const kvStart = Date.now();
      await kv.get('health-check');
      checks.kv = { ok: true, ms: Date.now() - kvStart };
    } else {
      checks.kv = { ok: false };
    }
  } catch {
    checks.kv = { ok: false };
  }

  // Check R2
  try {
    const r2 = env?.R2 || env?.BUCKET;
    checks.r2 = { ok: !!r2 };
  } catch {
    checks.r2 = { ok: false };
  }

  const allOk = Object.values(checks).every(c => c.ok);
  const status = allOk ? 'healthy' : 'degraded';

  return new Response(JSON.stringify({
    status,
    timestamp: new Date().toISOString(),
    latency: Date.now() - startTime,
    checks
  }), {
    status: allOk ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store'
    }
  });
};
