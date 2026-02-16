// src/pages/api/contact.ts
// Contact form endpoint - sends email via Resend
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { Resend } from 'resend';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { escapeHtml } from '../../lib/escape-html';
import { emailWrapper } from '../../lib/email-wrapper';
import { ApiErrors } from '../../lib/api-utils';

const ContactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email format').max(320),
  subject: z.string().min(1, 'Subject is required').max(200),
  message: z.string().min(1, 'Message is required').max(5000),
  orderNumber: z.string().max(100).optional(),
  reportType: z.string().max(100).optional(),
  reportedUser: z.string().max(500).optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Rate limit: 10 per 15 minutes to prevent spam
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`contact:${clientId}`, RateLimiters.auth);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    const env = locals.runtime.env;
    const apiKey = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!apiKey) {
      console.error('[Contact] RESEND_API_KEY not configured');
      return ApiErrors.serverError('Email service not configured');
    }

    const resend = new Resend(apiKey);
    const body = await request.json();
    const parsed = ContactSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { name, email, subject, message, orderNumber, reportType, reportedUser } = parsed.data;

    const esc = (s: string) => escapeHtml(s);

    // Build subject line
    const isReport = subject === 'report';
    const subjectLine = isReport
      ? `[REPORT] ${reportType || 'Issue'} - Fresh Wax Contact`
      : `[${subject.toUpperCase()}] Fresh Wax Contact Form`;

    // Build message body with escaped user inputs
    let messageBody = `
      <h2>New Contact Form Submission</h2>
      <p><strong>From:</strong> ${esc(name)}</p>
      <p><strong>Email:</strong> ${esc(email)}</p>
      <p><strong>Subject:</strong> ${esc(subject)}</p>
    `;

    if (orderNumber) {
      messageBody += `<p><strong>Order Number:</strong> ${esc(orderNumber)}</p>`;
    }

    if (isReport) {
      messageBody += `<p><strong>Report Type:</strong> ${esc(reportType || 'Not specified')}</p>`;
      if (reportedUser) {
        messageBody += `<p><strong>Reported User/URL:</strong> ${esc(reportedUser)}</p>`;
      }
    }

    messageBody += `
      <h3>Message:</h3>
      <p style="white-space: pre-wrap;">${esc(message)}</p>
      <hr>
      <p style="color: #888; font-size: 12px;">Sent from Fresh Wax contact form</p>
    `;

    // Send email to admin
    const contactContent = `
              <div style="color: #ffffff;" class="text-primary">
                ${messageBody}
              </div>`;

    const contactHtml = emailWrapper(contactContent, {
      title: 'Contact Form Submission',
      headerText: isReport ? 'Report Received' : 'Contact Form',
      hideHeader: true,
    });

    const result = await resend.emails.send({
      from: 'Fresh Wax Contact <noreply@freshwax.co.uk>',
      to: 'contact@freshwax.co.uk',
      replyTo: email,
      subject: subjectLine,
      html: contactHtml
    });

    if (import.meta.env.DEV) console.log('[Contact] Email sent:', result);

    return new Response(JSON.stringify({
      success: true,
      message: 'Message sent successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Contact] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to send message. Please try again.');
  }
};
