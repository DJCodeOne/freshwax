// src/pages/api/newsletter/subscribers.ts
// Get all subscribers for admin dashboard
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, deleteDocument, updateDocument, addDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const addSubscriberSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  source: z.string().optional(),
  adminId: z.string().optional(),
});

const deleteSubscriberSchema = z.object({
  subscriberId: z.string().min(1),
  adminId: z.string().optional(),
});

const updateSubscriberSchema = z.object({
  subscriberId: z.string().min(1),
  status: z.enum(['active', 'unsubscribed']),
  adminId: z.string().optional(),
});

const log = createLogger('newsletter/subscribers');

export const prerender = false;

// Max subscribers returned per request to prevent memory issues
const MAX_SUBSCRIBERS_PER_PAGE = 500;

export const GET: APIRoute = async ({ request, cookies, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`newsletter-subscribers:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
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

    return successResponse({ subscribers,
      stats });

  } catch (error: unknown) {
    log.error('Get subscribers error:', error);
    return ApiErrors.serverError('Failed to fetch subscribers');
  }
};

// Add subscriber manually
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`newsletter-subscribers:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json();
    const parseResult = addSubscriberSchema.safeParse(body);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const authError = await requireAdminAuth(request, locals, parseResult.data);
    if (authError) return authError;

    const { email, name, source } = parseResult.data;

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

    return successResponse({ message: 'Subscriber added',
      id: result.id });

  } catch (error: unknown) {
    log.error('Add subscriber error:', error);
    return ApiErrors.serverError('Failed to add subscriber');
  }
};

// Delete subscriber
export const DELETE: APIRoute = async ({ request, cookies, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`newsletter-subscribers:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json();
    const delParseResult = deleteSubscriberSchema.safeParse(body);
    if (!delParseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const authError = await requireAdminAuth(request, locals, delParseResult.data);
    if (authError) return authError;

    const { subscriberId } = delParseResult.data;

    await deleteDocument('subscribers', subscriberId);

    return successResponse({ message: 'Subscriber deleted' });

  } catch (error: unknown) {
    log.error('Delete subscriber error:', error);
    return ApiErrors.serverError('Failed to delete subscriber');
  }
};

// Update subscriber status (unsubscribe/resubscribe)
export const PATCH: APIRoute = async ({ request, cookies, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`newsletter-subscribers:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json();
    const patchParseResult = updateSubscriberSchema.safeParse(body);
    if (!patchParseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const authError = await requireAdminAuth(request, locals, patchParseResult.data);
    if (authError) return authError;

    const { subscriberId, status } = patchParseResult.data;

    await updateDocument('subscribers', subscriberId, {
      status,
      updatedAt: new Date()
    });

    return successResponse({ message: `Subscriber ${status === 'active' ? 'reactivated' : 'unsubscribed'}` });

  } catch (error: unknown) {
    log.error('Update subscriber error:', error);
    return ApiErrors.serverError('Failed to update subscriber');
  }
};
