// src/pages/api/health/payments.ts
// Health check endpoint for payment systems

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection } from '../../../lib/firebase-rest';
import { getWebhookStats } from '../../../lib/webhook-logger';
import { requireAdminAuth } from '../../../lib/admin';
import { createLogger, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('health/payments');

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
  // SECURITY: Admin-only — exposes payment system status and payout data
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const startTime = Date.now();
  const env = locals.runtime.env;

  // Initialize Firebase


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
    } catch (error: unknown) {
      result.checks.stripe = {
        status: 'error',
        error: 'Internal error'
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
  } catch (error: unknown) {
    result.checks.firebase = {
      status: 'error',
      error: 'Internal error'
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

    const totalPending = pendingPayouts.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0);
    result.checks.pendingPayouts = {
      count: pendingPayouts.length,
      totalAmount: Math.round(totalPending * 100) / 100
    };

    // Warning if many pending payouts
    if (pendingPayouts.length > 20) {
      issues.push(`${pendingPayouts.length} pending payouts need attention`);
    }

    // Count failed payouts (retry_pending with multiple retries)
    const failedPayouts = pendingPayouts.filter((p: Record<string, unknown>) => p.status === 'retry_pending' && ((p.retryCount as number) || 0) >= 3);
    result.checks.failedPayouts = { count: failedPayouts.length };

    if (failedPayouts.length > 0) {
      issues.push(`${failedPayouts.length} payouts have failed multiple times`);
    }
  } catch (error: unknown) {
    log.error('[Health Check] Error checking payouts:', error);
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
  } catch (error: unknown) {
    log.error('[Health Check] Error checking webhook stats:', error);
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

  return jsonResponse(result, httpStatus, {
    headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
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
