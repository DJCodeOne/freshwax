// src/pages/api/reports.ts
import type { APIRoute } from 'astro';
import { queryCollection, addDocument, updateDocument, deleteDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

const REPORT_CATEGORIES = ['inappropriate_content', 'harassment', 'spam', 'copyright', 'hate_speech', 'impersonation', 'other'];
const REPORT_TYPES = ['stream', 'artist', 'dj', 'user', 'release', 'mix', 'comment', 'chat', 'other'];

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  // SECURITY: Require admin authentication for viewing reports
  const { requireAdminAuth, initAdminEnv } = await import('../../lib/admin');
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = requireAdminAuth(request, locals);
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
    const filters: any[] = [];
    if (status !== 'all') filters.push({ field: 'status', op: 'EQUAL', value: status });
    if (type) filters.push({ field: 'type', op: 'EQUAL', value: type });

    const allReports = await queryCollection('reports', {
      filters: filters.length > 0 ? filters : undefined,
      limit
    });

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

    // Get counts
    const pendingReports = await queryCollection('reports', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }]
    });
    const reviewingReports = await queryCollection('reports', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'reviewing' }]
    });

    return new Response(JSON.stringify({
      success: true,
      reports,
      counts: { pending: pendingReports.length, reviewing: reviewingReports.length }
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const data = await request.json();
    const { type, targetId, targetName, targetUrl, category, description, reporterId, reporterName, reporterEmail } = data;

    if (!type || !REPORT_TYPES.includes(type)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid report type' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (!category || !REPORT_CATEGORIES.includes(category)) {
      return new Response(JSON.stringify({ success: false, error: 'Please select a category' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (!description || description.trim().length < 10) {
      return new Response(JSON.stringify({ success: false, error: 'Please provide a description (at least 10 characters)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (reporterId && targetId) {
      // Check for existing reports - need to check for pending or reviewing separately since REST API doesn't support 'in' operator
      const pendingReports = await queryCollection('reports', {
        filters: [
          { field: 'reporterId', op: 'EQUAL', value: reporterId },
          { field: 'targetId', op: 'EQUAL', value: targetId },
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        limit: 1
      });
      const reviewingReports = await queryCollection('reports', {
        filters: [
          { field: 'reporterId', op: 'EQUAL', value: reporterId },
          { field: 'targetId', op: 'EQUAL', value: targetId },
          { field: 'status', op: 'EQUAL', value: 'reviewing' }
        ],
        limit: 1
      });
      if (pendingReports.length > 0 || reviewingReports.length > 0) {
        return new Response(JSON.stringify({ success: false, error: 'You have already reported this content' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
    console.log('[Reports] New report:', result.id, type, category);

    return new Response(JSON.stringify({ success: true, reportId: result.id, message: 'Report submitted. Our team will review it shortly.' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  // SECURITY: Require admin authentication for updating reports
  const { requireAdminAuth, initAdminEnv } = await import('../../lib/admin');
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const data = await request.json();
    const { reportId, status, resolution, adminNotes, adminId } = data;
    if (!reportId) return new Response(JSON.stringify({ success: false, error: 'Report ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const updates: any = { updatedAt: new Date() };
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
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  // SECURITY: Require admin authentication for deleting reports
  const { requireAdminAuth, initAdminEnv } = await import('../../lib/admin');
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');
    if (!reportId) return new Response(JSON.stringify({ success: false, error: 'Report ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await deleteDocument('reports', reportId);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
