// src/pages/api/email-stats.ts
// Check daily email stats and retry skipped emails
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, deleteDocument, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

const DAILY_LIMIT = 100;

// GET: Check today's email stats
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    // Initialize Firebase environment
    const env = locals?.runtime?.env || {};
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const today = new Date().toISOString().split('T')[0];

    // Get today's count
    const statsDoc = await getDocument('email-stats', today);
    const todayCount = statsDoc ? (statsDoc.count || 0) : 0;

    // Get skipped emails count
    const skippedEmails = await queryCollection('skipped-emails', {
      filters: [{ field: 'skippedAt', op: 'GREATER_THAN_OR_EQUAL', value: today + 'T00:00:00.000Z' }],
      skipCache: true
    });

    // Get last 7 days stats
    const weekStats = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const doc = await getDocument('email-stats', dateStr);
      weekStats.push({
        date: dateStr,
        count: doc ? (doc.count || 0) : 0,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      today: {
        date: today,
        sent: todayCount,
        remaining: DAILY_LIMIT - todayCount,
        limit: DAILY_LIMIT,
        skipped: skippedEmails.length,
      },
      weekStats,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60',
      }
    });

  } catch (error) {
    log.error('[email-stats] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to get stats' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Retry skipped emails (admin)
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Initialize Firebase environment
    const env = locals?.runtime?.env || {};
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const { action } = await request.json();

    if (action === 'retry-skipped') {
      // Get today's count first
      const today = new Date().toISOString().split('T')[0];
      const statsDoc = await getDocument('email-stats', today);
      const todayCount = statsDoc ? (statsDoc.count || 0) : 0;

      if (todayCount >= DAILY_LIMIT) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Daily limit reached, try tomorrow',
          count: todayCount,
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get skipped emails
      const skippedEmails = await queryCollection('skipped-emails', {
        orderBy: { field: 'skippedAt', direction: 'ASCENDING' },
        limit: DAILY_LIMIT - todayCount,
        skipCache: true
      });

      if (skippedEmails.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          message: 'No skipped emails to retry',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let retried = 0;
      let failed = 0;

      for (const skippedEmail of skippedEmails) {
        try {
          // Retry sending via the main endpoint
          const response = await fetch(new URL('/api/send-order-emails', request.url).toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(skippedEmail.data),
          });

          const result = await response.json();

          if (result.success && !result.skipped) {
            // Successfully sent - delete from skipped
            await deleteDocument('skipped-emails', skippedEmail.id);
            retried++;
          } else {
            failed++;
          }
        } catch (e) {
          failed++;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        retried,
        failed,
        remaining: skippedEmails.length - retried - failed,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'clear-skipped') {
      // Clear all skipped emails older than 7 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);

      const oldEmails = await queryCollection('skipped-emails', {
        filters: [{ field: 'skippedAt', op: 'LESS_THAN', value: cutoff.toISOString() }],
        skipCache: true
      });

      // Delete each email individually
      for (const email of oldEmails) {
        await deleteDocument('skipped-emails', email.id);
      }

      return new Response(JSON.stringify({
        success: true,
        deleted: oldEmails.length,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[email-stats] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to process' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};