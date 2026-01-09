// src/pages/api/cron/stock-alerts.ts
// Scheduled job to send low stock alerts to admins

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, updateDocument, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

const LOW_STOCK_THRESHOLD = 5;

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  console.log('[Stock Alerts] ========== CRON JOB STARTED ==========');

  const env = (locals as any)?.runtime?.env;

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const isAuthorized =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (adminKey && xAdminKey === adminKey);

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  const ADMIN_EMAILS = (env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS || '').split(',').filter(Boolean);

  if (!RESEND_API_KEY || ADMIN_EMAILS.length === 0) {
    console.log('[Stock Alerts] Email not configured, skipping');
    return new Response(JSON.stringify({ success: true, skipped: true, reason: 'Email not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Check last alert time to avoid spam
    const lastAlert = await getDocument('system', 'lastStockAlert');
    const lastAlertTime = lastAlert?.timestamp ? new Date(lastAlert.timestamp).getTime() : 0;
    const hoursSinceLastAlert = (Date.now() - lastAlertTime) / (1000 * 60 * 60);

    if (hoursSinceLastAlert < 168) { // 7 days
      console.log('[Stock Alerts] Alert sent within last 7 days, skipping');
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: 'Alert sent recently',
        hoursSinceLastAlert: Math.round(hoursSinceLastAlert * 10) / 10
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Query low stock merch
    const lowStockMerch = await queryCollection('merch', {
      filters: [{ field: 'isLowStock', op: 'EQUAL', value: true }],
      limit: 100
    });

    // Query out of stock merch
    const outOfStockMerch = await queryCollection('merch', {
      filters: [{ field: 'isOutOfStock', op: 'EQUAL', value: true }],
      limit: 100
    });

    // Query low stock vinyl (releases with vinylStock <= 5)
    const allReleases = await queryCollection('releases', {
      filters: [{ field: 'hasVinyl', op: 'EQUAL', value: true }],
      limit: 200
    });

    const lowStockVinyl = allReleases.filter((r: any) =>
      (r.vinylStock || 0) > 0 && (r.vinylStock || 0) <= LOW_STOCK_THRESHOLD
    );

    const outOfStockVinyl = allReleases.filter((r: any) =>
      r.hasVinyl && (r.vinylStock || 0) === 0
    );

    const totalLow = lowStockMerch.length + lowStockVinyl.length;
    const totalOut = outOfStockMerch.length + outOfStockVinyl.length;

    if (totalLow === 0 && totalOut === 0) {
      console.log('[Stock Alerts] No stock issues found');
      return new Response(JSON.stringify({
        success: true,
        lowStock: 0,
        outOfStock: 0
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build email content
    let emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Stock Alert</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; text-align: center;">
              <h1 style="margin: 0; color: #fff; font-size: 24px;">Stock Alert</h1>
              <p style="margin: 10px 0 0; color: rgba(255,255,255,0.9);">${totalOut} out of stock, ${totalLow} low stock</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px;">`;

    // Out of stock section
    if (totalOut > 0) {
      emailHtml += `
              <h2 style="color: #ef4444; margin: 0 0 15px; font-size: 18px;">Out of Stock (${totalOut})</h2>
              <table width="100%" cellpadding="8" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">`;

      for (const item of outOfStockMerch.slice(0, 10)) {
        emailHtml += `
                <tr>
                  <td style="color: #fff; border-bottom: 1px solid #333;">${item.name || item.productName}</td>
                  <td style="color: #ef4444; text-align: right; border-bottom: 1px solid #333;">0 units</td>
                </tr>`;
      }

      for (const item of outOfStockVinyl.slice(0, 10)) {
        emailHtml += `
                <tr>
                  <td style="color: #fff; border-bottom: 1px solid #333;">${item.releaseName || item.name} (Vinyl)</td>
                  <td style="color: #ef4444; text-align: right; border-bottom: 1px solid #333;">0 units</td>
                </tr>`;
      }

      if (totalOut > 20) {
        emailHtml += `
                <tr>
                  <td colspan="2" style="color: #737373; text-align: center; padding: 10px;">...and ${totalOut - 20} more</td>
                </tr>`;
      }

      emailHtml += `
              </table>`;
    }

    // Low stock section
    if (totalLow > 0) {
      emailHtml += `
              <h2 style="color: #f59e0b; margin: 0 0 15px; font-size: 18px;">Low Stock (${totalLow})</h2>
              <table width="100%" cellpadding="8" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">`;

      for (const item of lowStockMerch.slice(0, 10)) {
        emailHtml += `
                <tr>
                  <td style="color: #fff; border-bottom: 1px solid #333;">${item.name || item.productName}</td>
                  <td style="color: #f59e0b; text-align: right; border-bottom: 1px solid #333;">${item.totalStock || item.stock || 0} units</td>
                </tr>`;
      }

      for (const item of lowStockVinyl.slice(0, 10)) {
        emailHtml += `
                <tr>
                  <td style="color: #fff; border-bottom: 1px solid #333;">${item.releaseName || item.name} (Vinyl)</td>
                  <td style="color: #f59e0b; text-align: right; border-bottom: 1px solid #333;">${item.vinylStock || 0} units</td>
                </tr>`;
      }

      if (totalLow > 20) {
        emailHtml += `
                <tr>
                  <td colspan="2" style="color: #737373; text-align: center; padding: 10px;">...and ${totalLow - 20} more</td>
                </tr>`;
      }

      emailHtml += `
              </table>`;
    }

    emailHtml += `
              <p style="text-align: center; margin: 20px 0 0;">
                <a href="https://freshwax.co.uk/admin/inventory" style="display: inline-block; background: #3b82f6; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Manage Inventory</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #0a0a0a; padding: 20px; text-align: center; border-top: 1px solid #262626;">
              <p style="margin: 0; color: #737373; font-size: 13px;">Fresh Wax Admin Alert</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    // Send email to all admins
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <alerts@freshwax.co.uk>',
        to: ADMIN_EMAILS,
        subject: `Stock Alert: ${totalOut} out of stock, ${totalLow} low stock`,
        html: emailHtml
      })
    });

    const emailResult = await emailResponse.json();
    console.log('[Stock Alerts] Email sent:', emailResponse.ok, emailResult);

    // Update last alert timestamp
    try {
      await updateDocument('system', 'lastStockAlert', {
        timestamp: new Date().toISOString(),
        lowStock: totalLow,
        outOfStock: totalOut
      });
    } catch {
      // Create if doesn't exist
      await addDocument('system', {
        timestamp: new Date().toISOString(),
        lowStock: totalLow,
        outOfStock: totalOut
      }, 'lastStockAlert');
    }

    const duration = Date.now() - startTime;
    console.log('[Stock Alerts] ========== COMPLETED ==========');
    console.log('[Stock Alerts] Duration:', duration, 'ms');

    return new Response(JSON.stringify({
      success: true,
      duration,
      lowStock: totalLow,
      outOfStock: totalOut,
      emailSent: emailResponse.ok
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Stock Alerts] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const GET: APIRoute = async (context) => POST(context);
