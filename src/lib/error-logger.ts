// src/lib/error-logger.ts
// Lightweight error logging to D1 for monitoring

interface ErrorLogEntry {
  source: 'client' | 'server';
  level?: 'error' | 'warn' | 'fatal';
  message: string;
  stack?: string;
  url?: string;
  endpoint?: string;
  statusCode?: number;
  userAgent?: string;
  ip?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

// Simple hash for error deduplication (group identical errors)
function fingerprint(message: string, stack?: string): string {
  const input = (message + (stack?.split('\n')[0] || '')).slice(0, 200);
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Log an error to D1. Non-blocking — failures are silently ignored.
 */
export async function logError(entry: ErrorLogEntry, env: any): Promise<void> {
  try {
    const db = env?.DB;
    if (!db) return;

    const fp = fingerprint(entry.message, entry.stack);

    await db.prepare(
      `INSERT INTO error_logs (source, level, message, stack, url, endpoint, status_code, user_agent, ip, user_id, metadata, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      entry.source,
      entry.level || 'error',
      entry.message.slice(0, 2000),
      (entry.stack || '').slice(0, 5000) || null,
      entry.url?.slice(0, 500) || null,
      entry.endpoint?.slice(0, 200) || null,
      entry.statusCode || null,
      entry.userAgent?.slice(0, 300) || null,
      entry.ip?.slice(0, 45) || null,
      entry.userId?.slice(0, 100) || null,
      entry.metadata ? JSON.stringify(entry.metadata).slice(0, 2000) : null,
      fp
    ).run();
  } catch {
    // Error logging must never throw
  }
}

/**
 * Log a server-side API error. Extracts IP and user-agent from request.
 */
export async function logServerError(
  error: unknown,
  request: Request,
  env: any,
  extra?: { endpoint?: string; statusCode?: number; userId?: string }
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  await logError({
    source: 'server',
    level: 'error',
    message,
    stack,
    endpoint: extra?.endpoint || new URL(request.url).pathname,
    statusCode: extra?.statusCode || 500,
    userAgent: request.headers.get('User-Agent') || undefined,
    ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || undefined,
    userId: extra?.userId,
  }, env);
}

/**
 * Cleanup old error logs (call from a cron or admin action).
 * Keeps last 7 days by default.
 */
export async function cleanupErrorLogs(env: any, daysToKeep = 7): Promise<number> {
  try {
    const db = env?.DB;
    if (!db) return 0;

    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const result = await db.prepare('DELETE FROM error_logs WHERE created_at < ?').bind(cutoff).run();
    return result?.meta?.changes || 0;
  } catch {
    return 0;
  }
}
