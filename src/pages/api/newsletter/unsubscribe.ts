// src/pages/api/newsletter/unsubscribe.ts
// Public endpoint for users to unsubscribe from newsletter
import type { APIRoute } from 'astro';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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
      unsubscribedAt: new Date(),
      updatedAt: new Date()
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
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to unsubscribe. Please try again.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
