// email.ts - Email notifications for merch processor

import { Resend } from 'resend';
import type { Env, ProcessedMerch } from './types';

/**
 * Send email when merch processing is complete
 */
export async function sendProcessingCompleteEmail(product: ProcessedMerch, env: Env): Promise<void> {
  if (!product.email) {
    console.log('[Email] No email address, skipping notification');
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);

  const productUrl = `https://freshwax.co.uk/merch/${product.id}`;

  try {
    await resend.emails.send({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: product.email,
      subject: `Your Product "${product.name}" is Live!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #111; color: #fff; padding: 20px; border-radius: 8px;">
          <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" style="height: 50px; margin-bottom: 20px;" />

          <h1 style="color: #dc2626; margin-bottom: 10px;">Your Product is Live!</h1>

          <p style="color: #9ca3af; font-size: 16px;">
            Hey ${product.supplierName},
          </p>

          <p style="color: #9ca3af; font-size: 16px;">
            Your product <strong style="color: #fff;">"${product.name}"</strong> has been processed and is now live on Fresh Wax!
          </p>

          ${product.imageUrl ? `<img src="${product.imageUrl}" alt="${product.name}" style="width: 200px; height: 200px; object-fit: cover; border-radius: 8px; margin: 20px 0;" />` : ''}

          <div style="background: #1f2937; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #fff;">
              <strong>Price:</strong> £${product.price.toFixed(2)}<br />
              <strong>Stock:</strong> ${product.stock} units<br />
              <strong>Category:</strong> ${product.category}
            </p>
          </div>

          <div style="margin: 30px 0;">
            <a href="${productUrl}" style="background: #dc2626; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              View Your Product
            </a>
          </div>

          <hr style="border: none; border-top: 1px solid #374151; margin: 30px 0;" />

          <p style="color: #6b7280; font-size: 12px;">
            Fresh Wax - Underground Music Store<br />
            <a href="https://freshwax.co.uk" style="color: #dc2626;">freshwax.co.uk</a>
          </p>
        </div>
      `
    });

    console.log(`[Email] Processing complete email sent to ${product.email}`);
  } catch (error) {
    console.error('[Email] Failed to send processing complete email:', error);
  }
}

/**
 * Send email when merch processing fails
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
      subject: `Merch Processing Failed: ${submissionId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">Merch Processing Failed</h1>

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
