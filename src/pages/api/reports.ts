// src/pages/api/reports.ts
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

const REPORT_CATEGORIES = ['inappropriate_content', 'harassment', 'spam', 'copyright', 'hate_speech', 'impersonation', 'other'];
const REPORT_TYPES = ['stream', 'artist', 'dj', 'user', 'release', 'mix', 'comment', 'chat', 'other'];

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'pending';
    const type = url.searchParams.get('type');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const alertsOnly = url.searchParams.get('alertsOnly') === 'true';
    
    if (alertsOnly) {
      const pendingCount = await db.collection('reports').where('status', '==', 'pending').count().get();
      return new Response(JSON.stringify({ success: true, pendingCount: pendingCount.data().count }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    let query: any = db.collection('reports');
    if (status !== 'all') query = query.where('status', '==', status);
    if (type) query = query.where('type', '==', type);
    
    const snapshot = await query.orderBy('createdAt', 'desc').limit(limit).get();
    const reports = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt
    }));
    
    const pendingCount = await db.collection('reports').where('status', '==', 'pending').count().get();
    const reviewingCount = await db.collection('reports').where('status', '==', 'reviewing').count().get();
    
    return new Response(JSON.stringify({
      success: true,
      reports,
      counts: { pending: pendingCount.data().count, reviewing: reviewingCount.data().count }
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
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
      const existing = await db.collection('reports')
        .where('reporterId', '==', reporterId)
        .where('targetId', '==', targetId)
        .where('status', 'in', ['pending', 'reviewing'])
        .limit(1).get();
      if (!existing.empty) {
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
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('reports').add(report);
    console.log('[Reports] New report:', docRef.id, type, category);
    
    return new Response(JSON.stringify({ success: true, reportId: docRef.id, message: 'Report submitted. Our team will review it shortly.' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const PUT: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { reportId, status, resolution, adminNotes, adminId } = data;
    if (!reportId) return new Response(JSON.stringify({ success: false, error: 'Report ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    
    const updates: any = { updatedAt: FieldValue.serverTimestamp() };
    if (status) {
      updates.status = status;
      if (status === 'resolved' || status === 'dismissed') {
        updates.resolvedAt = FieldValue.serverTimestamp();
        updates.resolvedBy = adminId || null;
      }
    }
    if (resolution) updates.resolution = resolution;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes;
    
    await db.collection('reports').doc(reportId).update(updates);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const DELETE: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');
    if (!reportId) return new Response(JSON.stringify({ success: false, error: 'Report ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await db.collection('reports').doc(reportId).delete();
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
