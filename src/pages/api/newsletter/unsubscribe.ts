// src/pages/api/newsletter/unsubscribe.ts
// Public endpoint for users to unsubscribe from newsletter
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { ApiErrors } from '../../../lib/api-utils';

const UnsubscribeSchema = z.object({
  email: z.string().email('Invalid email format').max(320),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  try {
    const body = await request.json();
    const parsed = UnsubscribeSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { email } = parsed.data;

    const normalizedEmail = email.toLowerCase().trim();

    // Find subscriber
    const subscribers = await queryCollection('subscribers', {
      filters: [{ field: 'email', op: 'EQUAL', value: normalizedEmail }],
      limit: 1
    });

    if (subscribers.length === 0) {
      // Email not found - still return success to avoid email enumeration
      return new Response(JSON.stringify({
        success: true,
        message: 'If this email was subscribed, it has been unsubscribed.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const subscriberDoc = subscribers[0];

    // Update status to unsubscribed
    await updateDocument('subscribers', subscriberDoc.id, {
      status: 'unsubscribed',
      unsubscribedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Successfully unsubscribed from newsletter'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Newsletter] Unsubscribe error:', error);
    return ApiErrors.serverError('Failed to unsubscribe. Please try again.');
  }
};
