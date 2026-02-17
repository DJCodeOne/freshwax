// src/pages/api/newsletter/send.ts
// Send newsletter to selected subscribers via Resend
import type { APIRoute } from 'astro';
import { queryCollection, addDocument, updateDocument, atomicIncrement } from '../../../lib/firebase-rest';
import { Resend } from 'resend';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { requireAdminAuth } from '../../../lib/admin';
import { escapeHtml, ApiErrors } from '../../../lib/api-utils';
import { SITE_URL } from '../../../lib/constants';
import { emailWrapper, ctaButton } from '../../../lib/email-wrapper';

export const prerender = false;

// Max 500 subscribers per newsletter send (prevent massive sends)
const MAX_SUBSCRIBERS_PER_SEND = 500;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const clientId = getClientId(request);

  // Rate limit: max 5 newsletter sends per hour
  const rateCheck = checkRateLimit(`newsletter-send:${clientId}`, {
    maxRequests: 5,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 60 * 60 * 1000
  });
  if (!rateCheck.allowed) {
    console.warn(`[Newsletter] Rate limit exceeded for ${clientId}`);
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = locals.runtime.env;

  // Initialize Resend with Cloudflare runtime env
  const resend = new Resend(env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY);

  try {
    // Check admin auth via X-Admin-Key header or body
    const body = await request.json();
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const {
      subject,
      content,
      subscriberIds, // Array of subscriber IDs, or 'all' for everyone
      previewEmail, // Optional: send preview to this email first
      testEmail // Alias for previewEmail
    } = body;

    if (!subject || !content) {
      return ApiErrors.badRequest('Subject and content are required');
    }

    // Get subscribers
    let subscribers: any[] = [];

    if (subscriberIds === 'all') {
      // Get all active subscribers
      subscribers = await queryCollection('subscribers', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'active' }]
      });
    } else if (Array.isArray(subscriberIds) && subscriberIds.length > 0) {
      // Get specific subscribers
      // Note: Firebase REST API 'IN' queries limited to 30 items, so batch if needed
      const batches = [];
      for (let i = 0; i < subscriberIds.length; i += 30) {
        batches.push(subscriberIds.slice(i, i + 30));
      }

      for (const batch of batches) {
        const batchResults = await queryCollection('subscribers', {
          filters: [
            { field: '__name__', op: 'IN', value: batch },
            { field: 'status', op: 'EQUAL', value: 'active' }
          ]
        });

        subscribers.push(...batchResults);
      }
    } else {
      return ApiErrors.badRequest('No subscribers selected');
    }

    if (subscribers.length === 0) {
      return ApiErrors.badRequest('No active subscribers found');
    }

    // Limit subscribers per send to prevent massive operations
    if (subscribers.length > MAX_SUBSCRIBERS_PER_SEND) {
      console.warn(`[Newsletter] Limiting send from ${subscribers.length} to ${MAX_SUBSCRIBERS_PER_SEND} subscribers`);
      subscribers = subscribers.slice(0, MAX_SUBSCRIBERS_PER_SEND);
    }

    // If preview/test email, send only to that
    const sendTestTo = previewEmail || testEmail;
    if (sendTestTo) {
      try {
        await resend.emails.send({
          from: 'Fresh Wax <noreply@freshwax.co.uk>',
          to: sendTestTo,
          subject: `[PREVIEW] ${subject}`,
          html: generateNewsletterHTML(subject, content, sendTestTo)
        });

        return new Response(JSON.stringify({
          success: true,
          message: `Preview sent to ${sendTestTo}`,
          previewSent: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (emailError) {
        console.error('[Newsletter] Preview email failed:', emailError);
        return ApiErrors.serverError('Failed to send preview email');
      }
    }

    // Save newsletter to database
    const newsletterResult = await addDocument('newsletters', {
      subject,
      content,
      sentAt: new Date(),
      sentBy: 'admin',
      recipientCount: subscribers.length,
      status: 'sending'
    });

    // Send emails in batches (Resend has rate limits)
    const results = {
      sent: 0,
      failed: 0,
      errors: [] as string[]
    };

    // Process in batches of 10 to avoid rate limits
    const BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES = 1000; // 1 second

    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
      const batch = subscribers.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (subscriber) => {
        try {
          await resend.emails.send({
            from: 'Fresh Wax <noreply@freshwax.co.uk>',
            to: subscriber.email,
            subject: subject,
            html: generateNewsletterHTML(subject, content, subscriber.email)
          });

          // Update subscriber stats atomically
          try {
            await atomicIncrement('subscribers', subscriber.id, { emailsSent: 1 });
            await updateDocument('subscribers', subscriber.id, {
              lastEmailSentAt: new Date()
            });
          } catch (updateError) {
            console.error(`[Newsletter] Failed to update stats for ${subscriber.email}:`, updateError);
            // Don't fail the send if stats update fails
          }

          results.sent++;
        } catch (err: unknown) {
          results.failed++;
          results.errors.push(`${subscriber.email}: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`[Newsletter] Failed to send to ${subscriber.email}:`, err);
        }
      }));

      // Delay between batches
      if (i + BATCH_SIZE < subscribers.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    // Update newsletter status
    await updateDocument('newsletters', newsletterResult.id, {
      status: results.failed === 0 ? 'sent' : 'partial',
      sentCount: results.sent,
      failedCount: results.failed,
      completedAt: new Date()
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Newsletter sent to ${results.sent} subscribers`,
      results: {
        sent: results.sent,
        failed: results.failed,
        total: subscribers.length
      },
      newsletterId: newsletterResult.id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Newsletter] Send error:', error);
    return ApiErrors.serverError('Failed to send newsletter');
  }
};

function generateNewsletterHTML(subject: string, content: string, email: string): string {
  // Escape subject to prevent HTML injection
  const safeSubject = escapeHtml(subject);

  // Escape content first, then apply markdown-style formatting
  // This prevents HTML injection while allowing safe markdown formatting
  let htmlContent = escapeHtml(content)
    // Headers (on escaped content)
    .replace(/^### (.*$)/gm, '<h3 style="color: #ffffff; margin: 25px 0 15px;" class="text-primary">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 style="color: #ffffff; margin: 30px 0 15px; font-size: 20px;" class="text-primary">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 style="color: #ffffff; margin: 30px 0 20px; font-size: 24px;" class="text-primary">$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #ffffff;" class="text-primary">$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Links - validate URLs to prevent javascript: injection
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color: #dc2626; text-decoration: underline;">$1</a>')
    // Line breaks
    .replace(/\n\n/g, '</p><p style="color: #a3a3a3; line-height: 1.7; margin-bottom: 15px;" class="text-secondary">')
    .replace(/\n/g, '<br>');

  // Wrap in paragraph tags
  htmlContent = `<p style="color: #a3a3a3; line-height: 1.7; margin-bottom: 15px;" class="text-secondary">${htmlContent}</p>`;

  const newsletterContent = `
              <h1 style="margin: 0 0 25px; font-size: 26px; color: #ffffff; border-bottom: 2px solid #dc2626; padding-bottom: 15px;" class="text-primary">${safeSubject}</h1>

              ${htmlContent}

              ${ctaButton('Visit Fresh Wax', SITE_URL)}`;

  const footerLinks = `
    <p style="color: #737373; font-size: 12px; margin: 0; text-align: center; line-height: 1.8;" class="text-muted">
      <a href="${SITE_URL}" style="color: #a3a3a3; text-decoration: none; margin: 0 8px;" class="text-secondary">Website</a>
      <a href="${SITE_URL}/releases/" style="color: #a3a3a3; text-decoration: none; margin: 0 8px;" class="text-secondary">Releases</a>
      <a href="${SITE_URL}/dj-mixes/" style="color: #a3a3a3; text-decoration: none; margin: 0 8px;" class="text-secondary">DJ Mixes</a>
      <br>
      <a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color: #737373; text-decoration: underline;">Unsubscribe from newsletter</a>
    </p>`;

  return emailWrapper(newsletterContent, {
    title: safeSubject,
    hideHeader: true,
    footerExtra: footerLinks,
  });
}
