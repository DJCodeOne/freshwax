// email.ts - Email notifications for mix processor

import { Resend } from 'resend';
import type { Env, ProcessedMix } from './types';

/**
 * Send email when mix processing is complete
 */
export async function sendProcessingCompleteEmail(mix: ProcessedMix, env: Env): Promise<void> {
  if (!mix.email) {
    console.log('[Email] No email address, skipping notification');
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);

  const mixUrl = `https://freshwax.co.uk/dj-mix/${mix.id}`;

  try {
    await resend.emails.send({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: mix.email,
      subject: `Your DJ Mix "${mix.title}" is Live!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #111; color: #fff; padding: 20px; border-radius: 8px;">
          <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" style="height: 50px; margin-bottom: 20px;" />

          <h1 style="color: #dc2626; margin-bottom: 10px;">Your Mix is Live!</h1>

          <p style="color: #9ca3af; font-size: 16px;">
            Hey ${mix.djName},
          </p>

          <p style="color: #9ca3af; font-size: 16px;">
            Your DJ mix <strong style="color: #fff;">"${mix.title}"</strong> has been processed and is now live on Fresh Wax!
          </p>

          ${mix.artworkUrl ? `<img src="${mix.artworkUrl}" alt="${mix.title}" style="width: 200px; height: 200px; object-fit: cover; border-radius: 8px; margin: 20px 0;" />` : ''}

          <div style="margin: 30px 0;">
            <a href="${mixUrl}" style="background: #dc2626; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              View Your Mix
            </a>
          </div>

          <p style="color: #6b7280; font-size: 14px;">
            Share your mix with your followers and start getting plays!
          </p>

          <hr style="border: none; border-top: 1px solid #374151; margin: 30px 0;" />

          <p style="color: #6b7280; font-size: 12px;">
            Fresh Wax - Underground Music Store<br />
            <a href="https://freshwax.co.uk" style="color: #dc2626;">freshwax.co.uk</a>
          </p>
        </div>
      `
    });

    console.log(`[Email] Processing complete email sent to ${mix.email}`);
  } catch (error) {
    console.error('[Email] Failed to send processing complete email:', error);
  }
}

/**
 * Send email when mix processing fails
 */
export async function sendProcessingFailedEmail(
  submissionId: string,
  errorMessage: string,
  env: Env
): Promise<void> {
  const resend = new Resend(env.RESEND_API_KEY);

  try {
    await resend.emails.send({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: env.ADMIN_EMAIL,
      subject: `Mix Processing Failed: ${submissionId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">Mix Processing Failed</h1>

          <p><strong>Submission ID:</strong> ${submissionId}</p>
          <p><strong>Error:</strong></p>
          <pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto;">${errorMessage}</pre>

          <p>Please check the worker logs for more details.</p>
        </div>
      `
    });

    console.log(`[Email] Processing failed email sent to admin`);
  } catch (error) {
    console.error('[Email] Failed to send processing failed email:', error);
  }
}
