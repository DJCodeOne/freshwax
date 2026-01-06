// src/pages/api/contact.ts
// Contact form endpoint - sends email via Resend
import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Rate limit: 10 per 15 minutes to prevent spam
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`contact:${clientId}`, RateLimiters.auth);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    const env = (locals as any)?.runtime?.env;
    const apiKey = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!apiKey) {
      console.error('[Contact] RESEND_API_KEY not configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'Email service not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const resend = new Resend(apiKey);
    const body = await request.json();
    const { name, email, subject, message, orderNumber, reportType, reportedUser } = body;

    // Validate required fields
    if (!name || !email || !subject || !message) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
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

    // Build subject line
    const isReport = subject === 'report';
    const subjectLine = isReport
      ? `[REPORT] ${reportType || 'Issue'} - Fresh Wax Contact`
      : `[${subject.toUpperCase()}] Fresh Wax Contact Form`;

    // Build message body
    let messageBody = `
      <h2>New Contact Form Submission</h2>
      <p><strong>From:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Subject:</strong> ${subject}</p>
    `;

    if (orderNumber) {
      messageBody += `<p><strong>Order Number:</strong> ${orderNumber}</p>`;
    }

    if (isReport) {
      messageBody += `<p><strong>Report Type:</strong> ${reportType || 'Not specified'}</p>`;
      if (reportedUser) {
        messageBody += `<p><strong>Reported User/URL:</strong> ${reportedUser}</p>`;
      }
    }

    messageBody += `
      <h3>Message:</h3>
      <p style="white-space: pre-wrap;">${message}</p>
      <hr>
      <p style="color: #888; font-size: 12px;">Sent from Fresh Wax contact form</p>
    `;

    // Send email to admin
    const result = await resend.emails.send({
      from: 'Fresh Wax Contact <noreply@freshwax.co.uk>',
      to: 'contact@freshwax.co.uk',
      replyTo: email,
      subject: subjectLine,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 20px; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #fff;">
          <div style="max-width: 600px; margin: 0 auto; background: #1a1a1a; border-radius: 12px; padding: 30px;">
            ${messageBody}
          </div>
        </body>
        </html>
      `
    });

    console.log('[Contact] Email sent:', result);

    return new Response(JSON.stringify({
      success: true,
      message: 'Message sent successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Contact] Error:', error?.message || error);
    return new Response(JSON.stringify({
      success: false,
      error: error?.message || 'Failed to send message. Please try again.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
