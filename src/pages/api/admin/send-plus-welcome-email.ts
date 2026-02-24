// src/pages/api/admin/send-plus-welcome-email.ts
// Sends welcome/confirmation email when user subscribes to Plus

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('[send-plus-welcome-email]');
import { emailWrapper, ctaButton, esc } from '../../../lib/email-wrapper';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`send-plus-welcome-email:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // SECURITY: Require admin authentication for sending emails
  const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
  

  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const body = await request.json();
    const { email, name, subscribedAt, expiresAt, plusId, isRenewal } = body;

    if (!email) {
      return ApiErrors.badRequest('Email address required');
    }

    // Get Resend API key
    const runtime = locals.runtime.env || {};
    const RESEND_API_KEY = runtime.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      log.info('[send-plus-welcome-email] No Resend API key configured');
      return jsonResponse({
        success: false,
        message: 'Email service not configured'
      });
    }

    // Format dates
    const subDate = subscribedAt ? new Date(subscribedAt) : new Date();
    const expDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const formatDate = (date: Date) => date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const formatTime = (date: Date) => date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    });

    const subscribedDateStr = formatDate(subDate);
    const subscribedTimeStr = formatTime(subDate);
    const expiresDateStr = formatDate(expDate);

    // Calculate days until expiry
    const daysUntilExpiry = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    const loginUrl = `${SITE_URL}/account/dashboard`;

    // Subject line based on renewal or new subscription
    const subject = isRenewal
      ? `Your Fresh Wax Plus subscription has been renewed! 👑`
      : `Welcome to Fresh Wax Plus! Your subscription is active 👑`;

    const headerText = isRenewal ? 'Subscription Renewed!' : 'Welcome to Plus!';
    const introText = isRenewal
      ? `Great news! Your Plus subscription has been successfully renewed.`
      : `Thanks for upgrading to Plus! Your subscription is now active and you have access to all Plus features.`;

    // Build email HTML using shared wrapper
    const plusContent = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${esc(name) || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;" class="text-secondary">
                ${introText}
              </p>

              <!-- Subscription Details Card -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border: 1px solid #374151; border-radius: 12px; margin-bottom: 30px;" class="detail-box border-subtle">
                <tr>
                  <td style="padding: 24px;">
                    <h3 style="color: #f59e0b; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 20px;">
                      Subscription Details
                    </h3>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${plusId ? `
                      <tr>
                        <td style="color: #9ca3af; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151;" class="text-muted border-subtle">Plus ID</td>
                        <td style="color: #ffffff; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151; text-align: right; font-family: monospace;" class="text-primary border-subtle">${esc(plusId)}</td>
                      </tr>
                      ` : ''}
                      <tr>
                        <td style="color: #9ca3af; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151;" class="text-muted border-subtle">Registered</td>
                        <td style="color: #ffffff; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151; text-align: right;" class="text-primary border-subtle">${subscribedDateStr} at ${subscribedTimeStr}</td>
                      </tr>
                      <tr>
                        <td style="color: #9ca3af; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151;" class="text-muted border-subtle">Valid Until</td>
                        <td style="color: #22c55e; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151; text-align: right; font-weight: 600;" class="border-subtle">${expiresDateStr}</td>
                      </tr>
                      <tr>
                        <td style="color: #9ca3af; font-size: 14px; padding: 8px 0;" class="text-muted">Subscription</td>
                        <td style="color: #f59e0b; font-size: 14px; padding: 8px 0; text-align: right; font-weight: 600;">Plus Annual (\u00a310/year)</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Benefits -->
              <p style="color: #ffffff; font-size: 16px; margin: 0 0 15px; font-weight: 600;" class="text-primary">
                Your Plus Benefits:
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 30px;">
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> 5 DJ mix uploads per week (vs 2 standard)</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> Long duration events up to 24 hours</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> Book multiple slots for day-long events</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> 1,000 tracks in cloud playlist (sync across devices)</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> !skip command (3 skips per day)</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> Record live stream button enabled</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> Gold crown on your chat avatar</td></tr>
                <tr><td style="padding: 6px 0; color: #a3a3a3; font-size: 15px;" class="text-secondary"><span style="color: #f59e0b; margin-right: 8px;">&#10003;</span> Priority in DJ Lobby queue</td></tr>
              </table>

              <!-- Renewal Notice -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 30px;">
                <tr>
                  <td style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 16px;">
                    <p style="color: #f59e0b; font-size: 14px; margin: 0; line-height: 1.5;">
                      <strong>About Renewals:</strong> Your Plus benefits will remain active for ${daysUntilExpiry} days.
                      If not renewed, your account will revert to Standard limits (no data is lost).
                      Simply renew anytime to reactivate Plus features!
                    </p>
                  </td>
                </tr>
              </table>

              ${ctaButton('Go to Dashboard', loginUrl, { gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', textColor: '#000000' })}

              <p style="color: #737373; font-size: 14px; margin: 0; line-height: 1.6; text-align: center;" class="text-muted">
                Questions? Just reply to this email or reach out anytime.
              </p>`;

    const emailHtml = emailWrapper(plusContent, {
      title: 'Fresh Wax Plus',
      headerText: headerText,
      headerGradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
      footerBrand: 'Fresh Wax Plus',
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
        subject: subject,
        html: emailHtml
      })
    }, 10000);

    if (!response.ok) {
      const errorResult = await response.json().catch(() => ({ message: 'Failed to send email' }));
      log.error('[send-plus-welcome-email] Resend error:', errorResult);
      return ApiErrors.serverError(errorResult.message || 'Failed to send email');
    }

    const result = await response.json();

    log.info('[send-plus-welcome-email] Email sent successfully to:', email);

    return successResponse({ messageId: result.id });

  } catch (error: unknown) {
    log.error('[send-plus-welcome-email] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
