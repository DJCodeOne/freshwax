// src/pages/api/newsletter/subscribe.ts
// Newsletter subscription endpoint - saves to Firebase and sends welcome email via Resend
import type { APIRoute } from 'astro';
import { getDocument, createDocumentIfNotExists, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

// Create a safe document ID from email (Firebase doc IDs can't contain / or .)
function emailToDocId(email: string): string {
  return email.toLowerCase().trim().replace(/[.@]/g, '_');
}
import { Resend } from 'resend';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`newsletter-subscribe:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Initialize Resend with Cloudflare runtime env
  const resend = new Resend(env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY);

  try {
    const body = await request.json();
    const { email, source = 'footer' } = body;

    if (!email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid email format'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const subscriberId = emailToDocId(normalizedEmail);

    // Try to check if already subscribed (may fail due to security rules)
    let existingDoc = null;
    try {
      existingDoc = await getDocument('subscribers', subscriberId);
    } catch (e) {
      // Security rules may block read - continue to try creating
      console.log('[Newsletter] Could not check existing subscriber, will try to create');
    }

    if (existingDoc) {
      // If unsubscribed, resubscribe them
      if (existingDoc.status === 'unsubscribed') {
        await updateDocument('subscribers', subscriberId, {
          status: 'active',
          resubscribedAt: new Date(),
          updatedAt: new Date()
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Welcome back! You have been resubscribed.'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'You are already subscribed!'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create new subscriber with deterministic ID (fails if already exists)
    const subscriberData = {
      email: normalizedEmail,
      status: 'active',
      source: source,
      subscribedAt: new Date(),
      updatedAt: new Date(),
      emailsSent: 0,
      emailsOpened: 0,
      lastEmailSentAt: null
    };

    const createResult = await createDocumentIfNotExists('subscribers', subscriberId, subscriberData);

    if (!createResult.success && createResult.exists) {
      // Document already exists - user is already subscribed
      return new Response(JSON.stringify({
        success: true,
        message: 'You are already subscribed!'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Send welcome email via Resend
    try {
      await resend.emails.send({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: normalizedEmail,
        subject: 'Welcome to Fresh Wax! 🎵',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <div style="text-align: center; margin-bottom: 30px;">
                <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" style="height: 60px; background: white; padding: 10px; border-radius: 8px;">
              </div>

              <div style="background: #1a1a1a; border-radius: 12px; padding: 30px; color: #fff;">
                <h1 style="margin: 0 0 20px; font-size: 24px; color: #fff;">Welcome to the Fresh Wax family! 🎧</h1>

                <p style="color: #ccc; line-height: 1.6; margin-bottom: 20px;">
                  Thanks for subscribing to our newsletter. You'll be the first to know about:
                </p>

                <ul style="color: #ccc; line-height: 1.8; margin-bottom: 25px; padding-left: 20px;">
                  <li>New jungle & drum and bass releases</li>
                  <li>Exclusive DJ mixes</li>
                  <li>Limited vinyl pressings</li>
                  <li>Fresh merch drops</li>
                  <li>Live stream announcements</li>
                </ul>

                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://freshwax.co.uk/releases" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold;">Browse Latest Releases</a>
                </div>

                <p style="color: #888; font-size: 14px; margin-top: 30px; text-align: center;">
                  Stay fresh! 🔊
                </p>
              </div>

              <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
                <p>© ${new Date().getFullYear()} Fresh Wax. All rights reserved.</p>
                <p style="margin-top: 10px;">
                  <a href="https://freshwax.co.uk/unsubscribe?email=${encodeURIComponent(normalizedEmail)}" style="color: #666;">Unsubscribe</a>
                </p>
              </div>
            </div>
          </body>
          </html>
        `
      });
    } catch (emailError) {
      console.error('[Newsletter] Welcome email failed:', emailError);
      // Don't fail the subscription if email fails
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Successfully subscribed! Check your inbox for a welcome email.',
      subscriberId: subscriberId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Newsletter] Subscribe error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to subscribe. Please try again.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
