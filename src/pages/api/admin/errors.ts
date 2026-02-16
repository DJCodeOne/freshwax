// src/pages/api/admin/errors.ts
// Admin API for querying and managing error logs

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { cleanupErrorLogs } from '../../../lib/error-logger';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

// GET /api/admin/errors/?source=client&limit=100&offset=0
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`errors:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authResult = await requireAdminAuth(request, locals);
  if (authResult) return authResult;

  const env = locals.runtime.env;
  const db = env?.DB;
  if (!db) {
    return ApiErrors.notConfigured('D1');
  }

  const url = new URL(request.url);
  const source = url.searchParams.get('source'); // 'client' or 'server'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const search = url.searchParams.get('q');

  let query = 'SELECT * FROM error_logs';
  const params: any[] = [];
  const conditions: string[] = [];

  if (source) {
    conditions.push('source = ?');
    params.push(source);
  }
  if (search) {
    conditions.push('(message LIKE ? OR url LIKE ? OR endpoint LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all();

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM error_logs';
    const countParams: any[] = [];
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
      countParams.push(...params.slice(0, -2)); // exclude limit/offset
    }
    const countResult = await db.prepare(countQuery).bind(...countParams).first();

    // Get grouped counts by fingerprint (top errors)
    const topErrors = await db.prepare(
      `SELECT fingerprint, message, source, COUNT(*) as count, MAX(created_at) as last_seen
       FROM error_logs
       WHERE created_at > datetime('now', '-24 hours')
       GROUP BY fingerprint
       ORDER BY count DESC
       LIMIT 10`
    ).all();

    return new Response(JSON.stringify({
      success: true,
      errors: result.results,
      total: (countResult as any)?.total || 0,
      topErrors: topErrors.results,
      limit,
      offset,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return ApiErrors.serverError('Failed to query error logs');
  }
};

// DELETE /api/admin/errors/ — cleanup old logs
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`errors-delete:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authResult = await requireAdminAuth(request, locals);
  if (authResult) return authResult;

  const env = locals.runtime.env;
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get('days') || '7');

  const deleted = await cleanupErrorLogs(env, days);

  return new Response(JSON.stringify({
    success: true,
    deleted,
    message: `Cleaned up errors older than ${days} days`,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
