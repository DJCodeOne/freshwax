// src/pages/api/admin/send-approval-email.ts
// Sends approval confirmation email to artists/partners

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';
import { emailWrapper, ctaButton } from '../../../lib/email-wrapper';

const sendApprovalEmailSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  type: z.string().optional(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`send-approval-email:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json().catch(() => ({}));

    // SECURITY: Require admin authentication via admin key (not spoofable UID)
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = sendApprovalEmailSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { email, name, type } = parsed.data;

    // Get Resend API key from runtime env or import.meta.env
    const runtime = locals.runtime.env || {};
    const RESEND_API_KEY = runtime.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[send-approval-email] No Resend API key configured');
      return new Response(JSON.stringify({
        success: false,
        message: 'Email service not configured'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const loginUrl = `${SITE_URL}/login?redirect=/account/dashboard`;

    // Determine role labels and content based on type
    const isArtist = type === 'artist' || type === 'both';
    const isMerch = type === 'merch' || type === 'both';
    const isVinyl = type === 'vinylSeller';

    // Build the approval message
    let approvalText = '';
    if (type === 'both') {
      approvalText = 'Your <strong style="color: #22c55e;">Artist</strong> and <strong style="color: #22c55e;">Merch</strong> application has been approved.';
    } else if (type === 'artist') {
      approvalText = 'Your <strong style="color: #22c55e;">Artist</strong> application has been approved.';
    } else if (type === 'vinylSeller') {
      approvalText = 'Your <strong style="color: #22c55e;">Vinyl Seller</strong> application has been approved.';
    } else if (type === 'merchSeller') {
      approvalText = 'Your <strong style="color: #22c55e;">Merch Seller</strong> application has been approved.';
    } else {
      approvalText = 'Your <strong style="color: #22c55e;">Partner</strong> application has been approved.';
    }

    // Build the subject line
    let subjectRole = '';
    if (type === 'both') {
      subjectRole = 'Artist & Merch Partner';
    } else if (type === 'artist') {
      subjectRole = 'Artist';
    } else if (type === 'vinylSeller') {
      subjectRole = 'Vinyl Seller';
    } else if (type === 'merchSeller') {
      subjectRole = 'Merch Seller';
    } else {
      subjectRole = 'Partner';
    }

    // Build features list based on approved roles
    let featuresList = '';
    if (isArtist) {
      featuresList += `
                <li>Upload and manage your releases</li>
                <li>Track your sales and royalties</li>
                <li>View your streaming statistics</li>`;
    }
    if (isMerch) {
      featuresList += `
                <li>Send your merchandise for automatic listing</li>
                <li>Monitor your inventory</li>
                <li>Track orders and sales</li>`;
    }
    if (isVinyl) {
      featuresList += `
                <li>List your vinyl records for sale</li>
                <li>Upload photos and audio samples</li>
                <li>Manage your vinyl listings</li>
                <li>Track orders and sales</li>`;
    }
    if (isArtist || isMerch || isVinyl) {
      featuresList += `
                <li>View your earnings</li>`;
    }

    // Build email HTML
    const approvalContent = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${name || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                Great news! ${approvalText} Welcome to the Fresh Wax community.
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;" class="text-secondary">
                You now have access to the Pro Dashboard where you can:
              </p>

              <ul style="color: #a3a3a3; font-size: 15px; margin: 0 0 30px; padding-left: 20px; line-height: 1.8;" class="text-secondary">${featuresList}
              </ul>

              ${ctaButton('Log In', loginUrl)}

              <p style="color: #a3a3a3; font-size: 14px; margin: 0; line-height: 1.6;" class="text-secondary">
                If you have any questions, just reply to this email or reach out to us anytime.
              </p>`;

    const emailHtml = emailWrapper(approvalContent, {
      title: 'Welcome to the Fresh Wax community.',
      headerText: "You're Approved!",
    });

    // Send via Resend
    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: email,
        subject: `Welcome to Fresh Wax! Your ${subjectRole} account is approved 🎉`,
        html: emailHtml
      })
    }, 10000);

    const result = await response.json();

    if (!response.ok) {
      console.error('[send-approval-email] Resend error:', result);
      return ApiErrors.serverError(result.message || 'Failed to send email');
    }

    console.log('[send-approval-email] Email sent successfully to:', email);

    return new Response(JSON.stringify({
      success: true,
      messageId: result.id
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[send-approval-email] Error:', error);
    return ApiErrors.serverError('Failed to send approval email');
  }
};
