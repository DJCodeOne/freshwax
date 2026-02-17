// src/pages/api/newsletter/subscribers.ts
// Get all subscribers for admin dashboard
import type { APIRoute } from 'astro';
import { queryCollection, deleteDocument, updateDocument, addDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

// Max subscribers returned per request to prevent memory issues
const MAX_SUBSCRIBERS_PER_PAGE = 500;

export const GET: APIRoute = async ({ request, cookies, locals }) => {  try {
    // Check admin auth via X-Admin-Key header
    const authError = await requireAdminAuth(request, locals);
    if (authError) return authError;

    // Get pagination params
    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const limit = Math.min(parseInt(limitParam || '500'), MAX_SUBSCRIBERS_PER_PAGE);

    const allSubscribers = await queryCollection('subscribers', {
      orderBy: { field: 'subscribedAt', direction: 'DESCENDING' },
      limit
    });

    const subscribers = allSubscribers.map(doc => {
      return {
        id: doc.id,
        email: doc.email,
        status: doc.status || 'active',
        source: doc.source || 'unknown',
        subscribedAt: doc.subscribedAt instanceof Date ? doc.subscribedAt.toISOString() : null,
        emailsSent: doc.emailsSent || 0,
        emailsOpened: doc.emailsOpened || 0,
        lastEmailSentAt: doc.lastEmailSentAt instanceof Date ? doc.lastEmailSentAt.toISOString() : null
      };
    });

    // Get stats
    const stats = {
      total: subscribers.length,
      active: subscribers.filter(s => s.status === 'active').length,
      unsubscribed: subscribers.filter(s => s.status === 'unsubscribed').length
    };

    return new Response(JSON.stringify({
      success: true,
      subscribers,
      stats
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Newsletter] Get subscribers error:', error);
    return ApiErrors.serverError('Failed to fetch subscribers');
  }
};

// Add subscriber manually
export const POST: APIRoute = async ({ request, cookies, locals }) => {  try {
    const body = await request.json();
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { email, name, source } = body;

    if (!email) {
      return ApiErrors.badRequest('Email is required');
    }

    // Check if email already exists
    const existing = await queryCollection('subscribers', {
      filters: [{ field: 'email', op: 'EQUAL', value: email.toLowerCase() }],
      limit: 1
    });

    if (existing.length > 0) {
      return ApiErrors.badRequest('Email already subscribed');
    }

    // Add subscriber
    const result = await addDocument('subscribers', {
      email: email.toLowerCase(),
      name: name || '',
      source: source || 'manual',
      status: 'active',
      subscribedAt: new Date(),
      emailsSent: 0,
      emailsOpened: 0
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscriber added',
      id: result.id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Newsletter] Add subscriber error:', error);
    return ApiErrors.serverError('Failed to add subscriber');
  }
};

// Delete subscriber
export const DELETE: APIRoute = async ({ request, cookies, locals }) => {  try {
    const body = await request.json();
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { subscriberId } = body;

    if (!subscriberId) {
      return ApiErrors.badRequest('Subscriber ID required');
    }

    await deleteDocument('subscribers', subscriberId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscriber deleted'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Newsletter] Delete subscriber error:', error);
    return ApiErrors.serverError('Failed to delete subscriber');
  }
};

// Update subscriber status (unsubscribe/resubscribe)
export const PATCH: APIRoute = async ({ request, cookies, locals }) => {  try {
    const body = await request.json();
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { subscriberId, status } = body;

    if (!subscriberId || !status) {
      return ApiErrors.badRequest('Subscriber ID and status required');
    }

    if (!['active', 'unsubscribed'].includes(status)) {
      return ApiErrors.badRequest('Invalid status');
    }

    await updateDocument('subscribers', subscriberId, {
      status,
      updatedAt: new Date()
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Subscriber ${status === 'active' ? 'reactivated' : 'unsubscribed'}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Newsletter] Update subscriber error:', error);
    return ApiErrors.serverError('Failed to update subscriber');
  }
};
