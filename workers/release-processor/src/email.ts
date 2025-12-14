// email.ts - Email notifications using Resend API
// Sends notifications when releases are processed

import type { Env, ProcessedRelease } from './types';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send email via Resend API
 */
async function sendEmail(options: EmailOptions, env: Env): Promise<boolean> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: options.to,
        subject: options.subject,
        html: options.html
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Email] Failed to send:', response.status, error);
      return false;
    }

    console.log(`[Email] Sent to ${options.to}: ${options.subject}`);
    return true;
  } catch (error) {
    console.error('[Email] Error sending:', error);
    return false;
  }
}

/**
 * Send notification when a release is successfully processed
 */
export async function sendProcessingCompleteEmail(
  release: ProcessedRelease,
  env: Env
): Promise<void> {
  const trackList = release.tracks
    .map(t => `<li>${t.trackNumber}. ${t.title}</li>`)
    .join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        .success { color: #22c55e; }
        .info { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0; }
        .info p { margin: 5px 0; }
        .tracks { margin: 15px 0; }
        .tracks ul { list-style: none; padding: 0; }
        .tracks li { padding: 5px 0; border-bottom: 1px solid #eee; }
        .btn { display: inline-block; background: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin-top: 15px; }
        img { max-width: 200px; border-radius: 8px; }
      </style>
    </head>
    <body>
      <h1>New Release Processed <span class="success">✓</span></h1>

      <p>A new release has been automatically processed and is ready for review.</p>

      ${release.coverUrl ? `<img src="${release.coverUrl}" alt="Cover art" />` : ''}

      <div class="info">
        <p><strong>Artist:</strong> ${release.artistName}</p>
        <p><strong>Release:</strong> ${release.releaseName}</p>
        <p><strong>Genre:</strong> ${release.genre || 'Not specified'}</p>
        <p><strong>Catalog #:</strong> ${release.catalogNumber || 'Not specified'}</p>
        <p><strong>Release ID:</strong> ${release.id}</p>
        <p><strong>Processed At:</strong> ${new Date(release.processedAt).toLocaleString()}</p>
      </div>

      <div class="tracks">
        <h3>Tracks (${release.tracks.length})</h3>
        <ul>${trackList}</ul>
      </div>

      <p><strong>Status:</strong> Pending approval</p>
      <p>The release has been added to Firebase and is waiting for admin approval before going live.</p>

      <a href="https://freshwax.co.uk/admin/releases/manage" class="btn">Review in Admin Panel</a>

      <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;" />
      <p style="color: #666; font-size: 12px;">
        This is an automated notification from Fresh Wax Release Processor.
      </p>
    </body>
    </html>
  `;

  await sendEmail({
    to: env.ADMIN_EMAIL,
    subject: `New Release: ${release.artistName} - ${release.releaseName}`,
    html
  }, env);
}

/**
 * Send notification when processing fails
 */
export async function sendProcessingFailedEmail(
  submissionId: string,
  error: string,
  env: Env
): Promise<void> {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        .error { color: #ef4444; }
        .info { background: #fef2f2; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid #fecaca; }
        .info p { margin: 5px 0; }
        pre { background: #1f2937; color: #f9fafb; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
      </style>
    </head>
    <body>
      <h1>Release Processing Failed <span class="error">✗</span></h1>

      <div class="info">
        <p><strong>Submission ID:</strong> ${submissionId}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
      </div>

      <h3>Error Details</h3>
      <pre>${error}</pre>

      <p>The release could not be automatically processed. Please check the submission files and try manual processing if needed.</p>

      <h3>Troubleshooting</h3>
      <ul>
        <li>Check if audio files are valid MP3/WAV format</li>
        <li>Ensure metadata.json is properly formatted</li>
        <li>Verify artwork is a valid image file</li>
        <li>Check Cloudflare Worker logs for more details</li>
      </ul>

      <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;" />
      <p style="color: #666; font-size: 12px;">
        This is an automated notification from Fresh Wax Release Processor.
      </p>
    </body>
    </html>
  `;

  await sendEmail({
    to: env.ADMIN_EMAIL,
    subject: `Release Processing Failed: ${submissionId}`,
    html
  }, env);
}

/**
 * Send notification when a submission is received (before processing)
 */
export async function sendSubmissionReceivedEmail(
  submissionId: string,
  artistName: string,
  releaseName: string,
  trackCount: number,
  env: Env
): Promise<void> {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        .pending { color: #f59e0b; }
        .info { background: #fffbeb; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid #fcd34d; }
        .info p { margin: 5px 0; }
      </style>
    </head>
    <body>
      <h1>New Submission Received <span class="pending">⏳</span></h1>

      <p>A new release has been submitted and is being processed.</p>

      <div class="info">
        <p><strong>Artist:</strong> ${artistName}</p>
        <p><strong>Release:</strong> ${releaseName}</p>
        <p><strong>Tracks:</strong> ${trackCount}</p>
        <p><strong>Submission ID:</strong> ${submissionId}</p>
        <p><strong>Received At:</strong> ${new Date().toLocaleString()}</p>
      </div>

      <p>Processing includes:</p>
      <ul>
        <li>Converting artwork to WebP format</li>
        <li>Creating MP3 and WAV versions of each track</li>
        <li>Generating 60-second preview clips</li>
        <li>Uploading to CDN</li>
      </ul>

      <p>You will receive another email when processing is complete.</p>

      <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;" />
      <p style="color: #666; font-size: 12px;">
        This is an automated notification from Fresh Wax Release Processor.
      </p>
    </body>
    </html>
  `;

  await sendEmail({
    to: env.ADMIN_EMAIL,
    subject: `Processing Started: ${artistName} - ${releaseName}`,
    html
  }, env);
}
