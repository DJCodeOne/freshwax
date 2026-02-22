// src/pages/api/reports.ts
import type { APIRoute } from 'astro';
import { queryCollection, addDocument, updateDocument, deleteDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { createLogger, ApiErrors } from '../../lib/api-utils';

const log = createLogger('[reports]');

export const prerender = false;

const REPORT_CATEGORIES = ['inappropriate_content', 'harassment', 'spam', 'copyright', 'hate_speech', 'impersonation', 'other'];
const REPORT_TYPES = ['stream', 'artist', 'dj', 'user', 'release', 'mix', 'comment', 'chat', 'other'];

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`reports:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // SECURITY: Require admin authentication for viewing reports
  const { requireAdminAuth, initAdminEnv } = await import('../../lib/admin');
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'pending';
    const type = url.searchParams.get('type');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const alertsOnly = url.searchParams.get('alertsOnly') === 'true';

    if (alertsOnly) {
      const pendingReports = await queryCollection('reports', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }]
      });
      return new Response(JSON.stringify({ success: true, pendingCount: pendingReports.length }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build filters
    const filters: Array<{ field: string; op: string; value: string }> = [];
    if (status !== 'all') filters.push({ field: 'status', op: 'EQUAL', value: status });
    if (type) filters.push({ field: 'type', op: 'EQUAL', value: type });

    // Run all queries in parallel instead of sequentially
    const [allReports, pendingReports, reviewingReports] = await Promise.all([
      queryCollection('reports', {
        filters: filters.length > 0 ? filters : undefined,
        limit
      }),
      queryCollection('reports', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }]
      }),
      queryCollection('reports', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'reviewing' }]
      }),
    ]);

    // Sort by createdAt client-side (descending)
    const reports = allReports
      .map(doc => ({
        ...doc,
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt
      }))
      .sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      })
      .slice(0, limit);

    return new Response(JSON.stringify({
      success: true,
      reports,
      counts: { pending: pendingReports.length, reviewing: reviewingReports.length }
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: unknown) {
    return ApiErrors.serverError('Internal error');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId2 = getClientId(request);
  const rateLimit2 = checkRateLimit(`reports-submit:${clientId2}`, RateLimiters.standard);
  if (!rateLimit2.allowed) {
    return rateLimitResponse(rateLimit2.retryAfter!);
  }

  try {
    const data = await request.json();
    const { type, targetId, targetName, targetUrl, category, description, reporterId, reporterName, reporterEmail } = data;

    if (!type || !REPORT_TYPES.includes(type)) {
      return ApiErrors.badRequest('Invalid report type');
    }
    if (!category || !REPORT_CATEGORIES.includes(category)) {
      return ApiErrors.badRequest('Please select a category');
    }
    if (!description || description.trim().length < 10) {
      return ApiErrors.badRequest('Please provide a description (at least 10 characters)');
    }

    if (reporterId && targetId) {
      // Check for existing reports in parallel
      const [pendingReports, reviewingReports] = await Promise.all([
        queryCollection('reports', {
          filters: [
            { field: 'reporterId', op: 'EQUAL', value: reporterId },
            { field: 'targetId', op: 'EQUAL', value: targetId },
            { field: 'status', op: 'EQUAL', value: 'pending' }
          ],
          limit: 1
        }),
        queryCollection('reports', {
          filters: [
            { field: 'reporterId', op: 'EQUAL', value: reporterId },
            { field: 'targetId', op: 'EQUAL', value: targetId },
            { field: 'status', op: 'EQUAL', value: 'reviewing' }
          ],
          limit: 1
        }),
      ]);
      if (pendingReports.length > 0 || reviewingReports.length > 0) {
        return ApiErrors.badRequest('You have already reported this content');
      }
    }

    const priority = ['hate_speech', 'harassment'].includes(category) ? 'urgent' :
      ['stream', 'chat'].includes(type) ? 'high' :
      ['inappropriate_content', 'impersonation'].includes(category) ? 'high' :
      ['copyright', 'spam'].includes(category) ? 'medium' : 'low';

    const report = {
      type, targetId: targetId || null, targetName: targetName || 'Unknown', targetUrl: targetUrl || null,
      category, description: description.trim(), reporterId: reporterId || null,
      reporterName: reporterName || 'Anonymous', reporterEmail: reporterEmail || null,
      status: 'pending', priority, resolution: null, resolvedBy: null, resolvedAt: null, adminNotes: null,
      createdAt: new Date(), updatedAt: new Date()
    };

    const result = await addDocument('reports', report);
    log.info('New report:', result.id, type, category);

    return new Response(JSON.stringify({ success: true, reportId: result.id, message: 'Report submitted. Our team will review it shortly.' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    return ApiErrors.serverError('Internal error');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId3 = getClientId(request);
  const rateLimit3 = checkRateLimit(`reports-update:${clientId3}`, RateLimiters.standard);
  if (!rateLimit3.allowed) {
    return rateLimitResponse(rateLimit3.retryAfter!);
  }

  // SECURITY: Require admin authentication for updating reports
  const { requireAdminAuth, initAdminEnv } = await import('../../lib/admin');
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const data = await request.json();
    const { reportId, status, resolution, adminNotes, adminId } = data;
    if (!reportId) return ApiErrors.badRequest('Report ID required');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status) {
      updates.status = status;
      if (status === 'resolved' || status === 'dismissed') {
        updates.resolvedAt = new Date();
        updates.resolvedBy = adminId || null;
      }
    }
    if (resolution) updates.resolution = resolution;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes;

    await updateDocument('reports', reportId, updates);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: unknown) {
    return ApiErrors.serverError('Internal error');
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId4 = getClientId(request);
  const rateLimit4 = checkRateLimit(`reports-delete:${clientId4}`, RateLimiters.standard);
  if (!rateLimit4.allowed) {
    return rateLimitResponse(rateLimit4.retryAfter!);
  }

  // SECURITY: Require admin authentication for deleting reports
  const { requireAdminAuth, initAdminEnv } = await import('../../lib/admin');
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');
    if (!reportId) return ApiErrors.badRequest('Report ID required');
    await deleteDocument('reports', reportId);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: unknown) {
    return ApiErrors.serverError('Internal error');
  }
};
