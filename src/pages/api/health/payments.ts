// src/pages/api/health/payments.ts
// Health check endpoint for payment systems

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getWebhookStats } from '../../../lib/webhook-logger';

export const prerender = false;

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    stripe: { status: string; latency?: number; error?: string };
    firebase: { status: string; latency?: number; error?: string };
    pendingPayouts: { count: number; totalAmount: number };
    failedPayouts: { count: number };
    webhookHealth: { total24h: number; failed24h: number; successRate: number };
  };
  summary: string;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  const env = (locals as any)?.runtime?.env;

  // Initialize Firebase
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const result: HealthCheckResult = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {
      stripe: { status: 'unknown' },
      firebase: { status: 'unknown' },
      pendingPayouts: { count: 0, totalAmount: 0 },
      failedPayouts: { count: 0 },
      webhookHealth: { total24h: 0, failed24h: 0, successRate: 100 }
    },
    summary: ''
  };

  const issues: string[] = [];

  // Check Stripe connectivity
  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (stripeSecretKey) {
    try {
      const stripeStart = Date.now();
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

      // Simple balance check to verify API access
      await stripe.balance.retrieve();

      result.checks.stripe = {
        status: 'ok',
        latency: Date.now() - stripeStart
      };
    } catch (error: any) {
      result.checks.stripe = {
        status: 'error',
        error: error.message
      };
      issues.push('Stripe API unreachable');
    }
  } else {
    result.checks.stripe = {
      status: 'error',
      error: 'Stripe not configured'
    };
    issues.push('Stripe not configured');
  }

  // Check Firebase connectivity
  try {
    const fbStart = Date.now();

    // Simple query to verify Firebase access
    await queryCollection('payouts', { limit: 1 });

    result.checks.firebase = {
      status: 'ok',
      latency: Date.now() - fbStart
    };
  } catch (error: any) {
    result.checks.firebase = {
      status: 'error',
      error: error.message
    };
    issues.push('Firebase unreachable');
  }

  // Check pending payouts
  try {
    const pendingPayouts = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending', 'processing'] }
      ],
      limit: 100
    });

    const totalPending = pendingPayouts.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
    result.checks.pendingPayouts = {
      count: pendingPayouts.length,
      totalAmount: Math.round(totalPending * 100) / 100
    };

    // Warning if many pending payouts
    if (pendingPayouts.length > 20) {
      issues.push(`${pendingPayouts.length} pending payouts need attention`);
    }

    // Count failed payouts (retry_pending with multiple retries)
    const failedPayouts = pendingPayouts.filter((p: any) => p.status === 'retry_pending' && (p.retryCount || 0) >= 3);
    result.checks.failedPayouts = { count: failedPayouts.length };

    if (failedPayouts.length > 0) {
      issues.push(`${failedPayouts.length} payouts have failed multiple times`);
    }
  } catch (error: any) {
    console.error('[Health Check] Error checking payouts:', error);
  }

  // Check webhook health
  try {
    const webhookStats = await getWebhookStats(24);
    result.checks.webhookHealth = {
      total24h: webhookStats.total,
      failed24h: webhookStats.failed,
      successRate: webhookStats.total > 0
        ? Math.round((webhookStats.successful / webhookStats.total) * 100)
        : 100
    };

    // Warning if high failure rate
    if (webhookStats.total >= 10 && result.checks.webhookHealth.successRate < 95) {
      issues.push(`Webhook success rate is ${result.checks.webhookHealth.successRate}%`);
    }
  } catch (error: any) {
    console.error('[Health Check] Error checking webhook stats:', error);
  }

  // Determine overall status
  if (result.checks.stripe.status === 'error' || result.checks.firebase.status === 'error') {
    result.status = 'unhealthy';
  } else if (issues.length > 0) {
    result.status = 'degraded';
  }

  // Generate summary
  if (result.status === 'healthy') {
    result.summary = 'All payment systems operational';
  } else if (result.status === 'degraded') {
    result.summary = `Issues detected: ${issues.join('; ')}`;
  } else {
    result.summary = `Critical issues: ${issues.join('; ')}`;
  }

  // Set appropriate HTTP status
  const httpStatus = result.status === 'unhealthy' ? 503 : 200;

  return new Response(JSON.stringify(result, null, 2), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
};

// Also support HEAD requests for simple health checks
export const HEAD: APIRoute = async (context) => {
  const response = await GET(context);
  const status = response.status;

  return new Response(null, {
    status,
    headers: {
      'X-Health-Status': status === 200 ? 'healthy' : 'unhealthy'
    }
  });
};
