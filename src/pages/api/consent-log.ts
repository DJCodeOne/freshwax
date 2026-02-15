// src/pages/api/consent-log.ts
// GDPR compliance: Server-side audit trail for cookie consent decisions
// Logs consent choices with timestamp, IP, and categories to Firestore

import type { APIRoute } from 'astro';
import { addDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors } from '../../lib/api-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`consent-log:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json();
    const { necessary, analytics, marketing, action } = body;

    if (typeof analytics !== 'boolean' || typeof marketing !== 'boolean') {
      return ApiErrors.badRequest('Invalid consent data');
    }

    await addDocument('consentLogs', {
      necessary: true,
      analytics: !!analytics,
      marketing: !!marketing,
      action: action || 'save', // 'accept_all', 'reject_all', 'save'
      ip: clientId,
      userAgent: request.headers.get('user-agent') || '',
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[consent-log] Error:', error);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
