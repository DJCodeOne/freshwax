// src/pages/api/newsletter/send.ts
// Send newsletter to selected subscribers via Resend
import type { APIRoute } from 'astro';
import { queryCollection, addDocument, updateDocument, incrementField, initFirebaseEnv } from '../../../lib/firebase-rest';
import { Resend } from 'resend';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

export const prerender = false;

// Max 500 subscribers per newsletter send (prevent massive sends)
const MAX_SUBSCRIBERS_PER_SEND = 500;

// HTML escape function to prevent XSS/injection
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

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

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Initialize Resend with Cloudflare runtime env
  const resend = new Resend(env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY);

  try {
    // Check admin auth
    const adminId = cookies.get('adminId')?.value;
    if (!adminId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const {
      subject,
      content,
      subscriberIds, // Array of subscriber IDs, or 'all' for everyone
      previewEmail // Optional: send preview to this email first
    } = body;

    if (!subject || !content) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Subject and content are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
      return new Response(JSON.stringify({
        success: false,
        error: 'No subscribers selected'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (subscribers.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No active subscribers found'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limit subscribers per send to prevent massive operations
    if (subscribers.length > MAX_SUBSCRIBERS_PER_SEND) {
      console.warn(`[Newsletter] Limiting send from ${subscribers.length} to ${MAX_SUBSCRIBERS_PER_SEND} subscribers`);
      subscribers = subscribers.slice(0, MAX_SUBSCRIBERS_PER_SEND);
    }

    // If preview email, send only to that
    if (previewEmail) {
      try {
        await resend.emails.send({
          from: 'Fresh Wax <noreply@freshwax.co.uk>',
          to: previewEmail,
          subject: `[PREVIEW] ${subject}`,
          html: generateNewsletterHTML(subject, content, previewEmail)
        });

        return new Response(JSON.stringify({
          success: true,
          message: `Preview sent to ${previewEmail}`,
          previewSent: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (emailError) {
        console.error('[Newsletter] Preview email failed:', emailError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to send preview email'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Save newsletter to database
    const newsletterResult = await addDocument('newsletters', {
      subject,
      content,
      sentAt: new Date(),
      sentBy: adminId,
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

          // Update subscriber stats using incrementField
          try {
            await incrementField('subscribers', subscriber.id, 'emailsSent', 1);
            await updateDocument('subscribers', subscriber.id, {
              lastEmailSentAt: new Date()
            });
          } catch (updateError) {
            console.error(`[Newsletter] Failed to update stats for ${subscriber.email}:`, updateError);
            // Don't fail the send if stats update fails
          }

          results.sent++;
        } catch (err: any) {
          results.failed++;
          results.errors.push(`${subscriber.email}: ${err.message}`);
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

  } catch (error) {
    console.error('[Newsletter] Send error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send newsletter'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function generateNewsletterHTML(subject: string, content: string, email: string): string {
  // Escape subject to prevent HTML injection
  const safeSubject = escapeHtml(subject);

  // Escape content first, then apply markdown-style formatting
  // This prevents HTML injection while allowing safe markdown formatting
  let htmlContent = escapeHtml(content)
    // Headers (on escaped content)
    .replace(/^### (.*$)/gm, '<h3 style="color: #fff; margin: 25px 0 15px;">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 style="color: #fff; margin: 30px 0 15px; font-size: 20px;">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 style="color: #fff; margin: 30px 0 20px; font-size: 24px;">$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #fff;">$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Links - validate URLs to prevent javascript: injection
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color: #dc2626; text-decoration: underline;">$1</a>')
    // Line breaks
    .replace(/\n\n/g, '</p><p style="color: #ccc; line-height: 1.7; margin-bottom: 15px;">')
    .replace(/\n/g, '<br>');

  // Wrap in paragraph tags
  htmlContent = `<p style="color: #ccc; line-height: 1.7; margin-bottom: 15px;">${htmlContent}</p>`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <a href="https://freshwax.co.uk">
            <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" style="height: 60px; background: white; padding: 10px; border-radius: 8px;">
          </a>
        </div>

        <div style="background: #1a1a1a; border-radius: 12px; padding: 30px; color: #fff;">
          <h1 style="margin: 0 0 25px; font-size: 26px; color: #fff; border-bottom: 2px solid #dc2626; padding-bottom: 15px;">${safeSubject}</h1>

          ${htmlContent}

          <div style="text-align: center; margin: 35px 0 20px;">
            <a href="https://freshwax.co.uk" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold;">Visit Fresh Wax</a>
          </div>
        </div>

        <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
          <p>© ${new Date().getFullYear()} Fresh Wax. All rights reserved.</p>
          <p style="margin-top: 10px;">
            <a href="https://freshwax.co.uk" style="color: #888; margin: 0 10px;">Website</a>
            <a href="https://freshwax.co.uk/releases" style="color: #888; margin: 0 10px;">Releases</a>
            <a href="https://freshwax.co.uk/dj-mixes" style="color: #888; margin: 0 10px;">DJ Mixes</a>
          </p>
          <p style="margin-top: 15px;">
            <a href="https://freshwax.co.uk/unsubscribe?email=${encodeURIComponent(email)}" style="color: #666;">Unsubscribe from newsletter</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}
