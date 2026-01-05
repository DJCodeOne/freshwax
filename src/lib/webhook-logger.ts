// src/lib/webhook-logger.ts
// Webhook event logging for debugging and monitoring

import { addDocument, queryCollection } from './firebase-rest';

// Log levels
export type LogLevel = 'info' | 'warning' | 'error' | 'debug';

// Webhook event structure
export interface WebhookEvent {
  source: 'stripe' | 'stripe_connect' | 'other';
  eventType: string;
  eventId?: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, any>;
  timestamp: string;
  processingTimeMs?: number;
  success: boolean;
  error?: string;
}

// Maximum events to keep per day (to avoid excessive storage)
const MAX_DAILY_EVENTS = 1000;

// Log a webhook event
export async function logWebhookEvent(event: Omit<WebhookEvent, 'timestamp'>): Promise<void> {
  try {
    const eventWithTimestamp: WebhookEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };

    await addDocument('webhookLogs', eventWithTimestamp);
  } catch (error) {
    // Don't let logging failures crash the webhook
    console.error('[Webhook Logger] Failed to log event:', error);
  }
}

// Helper for logging Stripe webhook events
export async function logStripeEvent(
  eventType: string,
  eventId: string,
  success: boolean,
  options: {
    message?: string;
    level?: LogLevel;
    metadata?: Record<string, any>;
    processingTimeMs?: number;
    error?: string;
  } = {}
): Promise<void> {
  const {
    message = success ? `Processed ${eventType}` : `Failed to process ${eventType}`,
    level = success ? 'info' : 'error',
    metadata,
    processingTimeMs,
    error
  } = options;

  await logWebhookEvent({
    source: 'stripe',
    eventType,
    eventId,
    level,
    message,
    metadata,
    processingTimeMs,
    success,
    error
  });
}

// Helper for logging Connect webhook events
export async function logConnectEvent(
  eventType: string,
  eventId: string,
  success: boolean,
  options: {
    message?: string;
    level?: LogLevel;
    metadata?: Record<string, any>;
    processingTimeMs?: number;
    error?: string;
  } = {}
): Promise<void> {
  const {
    message = success ? `Processed ${eventType}` : `Failed to process ${eventType}`,
    level = success ? 'info' : 'error',
    metadata,
    processingTimeMs,
    error
  } = options;

  await logWebhookEvent({
    source: 'stripe_connect',
    eventType,
    eventId,
    level,
    message,
    metadata,
    processingTimeMs,
    success,
    error
  });
}

// Get recent webhook events (for admin dashboard)
export async function getRecentWebhookEvents(
  limit: number = 50,
  source?: 'stripe' | 'stripe_connect' | 'other'
): Promise<WebhookEvent[]> {
  try {
    const filters: any[] = [];
    if (source) {
      filters.push({ field: 'source', op: 'EQUAL', value: source });
    }

    const events = await queryCollection('webhookLogs', {
      filters,
      orderBy: [{ field: 'timestamp', direction: 'DESCENDING' }],
      limit
    });

    return events;
  } catch (error) {
    console.error('[Webhook Logger] Failed to get events:', error);
    return [];
  }
}

// Get failed webhook events (for debugging)
export async function getFailedWebhookEvents(limit: number = 50): Promise<WebhookEvent[]> {
  try {
    const events = await queryCollection('webhookLogs', {
      filters: [{ field: 'success', op: 'EQUAL', value: false }],
      orderBy: [{ field: 'timestamp', direction: 'DESCENDING' }],
      limit
    });

    return events;
  } catch (error) {
    console.error('[Webhook Logger] Failed to get failed events:', error);
    return [];
  }
}

// Get webhook event stats for a time period
export async function getWebhookStats(hours: number = 24): Promise<{
  total: number;
  successful: number;
  failed: number;
  byEventType: Record<string, { total: number; successful: number; failed: number }>;
}> {
  try {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const events = await queryCollection('webhookLogs', {
      filters: [{ field: 'timestamp', op: 'GREATER_THAN_OR_EQUAL', value: cutoff }],
      limit: MAX_DAILY_EVENTS
    });

    const stats = {
      total: events.length,
      successful: 0,
      failed: 0,
      byEventType: {} as Record<string, { total: number; successful: number; failed: number }>
    };

    for (const event of events) {
      if (event.success) {
        stats.successful++;
      } else {
        stats.failed++;
      }

      const type = event.eventType || 'unknown';
      if (!stats.byEventType[type]) {
        stats.byEventType[type] = { total: 0, successful: 0, failed: 0 };
      }
      stats.byEventType[type].total++;
      if (event.success) {
        stats.byEventType[type].successful++;
      } else {
        stats.byEventType[type].failed++;
      }
    }

    return stats;
  } catch (error) {
    console.error('[Webhook Logger] Failed to get stats:', error);
    return { total: 0, successful: 0, failed: 0, byEventType: {} };
  }
}
