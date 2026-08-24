// src/pages/api/stripe/connect/webhook.ts
// Handles Stripe Connect webhook events
// Supports artists, suppliers, and users (crate sellers)

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection, updateDocument, addDocument, getDocument, atomicIncrement } from '@lib/firebase-rest';
import { sendPayoutCompletedEmail } from '@lib/payout-emails';
import { logConnectEvent } from '@lib/webhook-logger';
import { createPayout as createPayPalPayout, getPayPalConfig } from '@lib/paypal-payouts';
import { processPendingPayouts } from '@lib/stripe-connect-payouts';
import { createLogger, jsonResponse } from '@lib/api-utils';

const log = createLogger('[connect-webhook]');

export const prerender = false;

// Operator policy (Aug 2026): ALL payouts are manual — the operator checks
// the platform balance and triggers transfers via /api/admin/send-stripe-payout.
// Set PAYOUTS_AUTO_TRANSFER=true to re-enable automatic payout of the pending
// backlog when an account completes Connect onboarding.
const autoTransfersEnabled = (env: Record<string, unknown> | undefined) => env?.PAYOUTS_AUTO_TRANSFER === 'true';

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();

  // Initialize Firebase
  const env = locals.runtime.env;


  // Get Stripe keys
  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  const webhookSecret = env?.STRIPE_CONNECT_WEBHOOK_SECRET || import.meta.env.STRIPE_CONNECT_WEBHOOK_SECRET;

  if (!stripeSecretKey) {
    log.error('Stripe secret key not configured');
    return new Response('Stripe not configured', { status: 500 });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const body = await request.text();
    const sig = request.headers.get('stripe-signature');

    if (!sig) {
      log.error('Missing signature header - REJECTING');
      return new Response('Missing signature', { status: 401 });
    }

    let event: Stripe.Event;

    // SECURITY: Signature verification is REQUIRED
    // Only skip in local development if explicitly configured
    const isDevelopment = import.meta.env.DEV;

    if (webhookSecret) {
      try {
        event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log.error('Signature verification failed:', errMessage);
        return new Response('Webhook signature verification failed', { status: 401 });
      }
    } else if (!isDevelopment) {
      // SECURITY: In production, REQUIRE webhook secret - reject without it
      log.error('SECURITY: Webhook secret not configured in production - REJECTING');
      return new Response('Webhook not configured', { status: 500 });
    } else {
      // Only in local dev - allow without verification
      log.warn('⚠️ DEV MODE: Skipping signature verification');
      try {
        event = JSON.parse(body);
      } catch (_e: unknown) {
        // non-critical: dev mode webhook body is not valid JSON
        log.error('Invalid JSON payload in dev mode');
        return new Response('Invalid JSON payload', { status: 400 });
      }
    }

    log.info('Received event:', event.type);

    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account, stripeSecretKey, env);
        logConnectEvent(event.type, event.id, true, {
          message: `Account updated: ${(event.data.object as Stripe.Account).id}`,
          metadata: { accountId: (event.data.object as Stripe.Account).id },
          processingTimeMs: Date.now() - startTime
        }).catch(e => log.error('Log error:', e));
        break;

      case 'transfer.created':
        await handleTransferCreated(event.data.object as Stripe.Transfer);
        logConnectEvent(event.type, event.id, true, {
          message: `Transfer created: ${(event.data.object as Stripe.Transfer).id}`,
          metadata: { transferId: (event.data.object as Stripe.Transfer).id },
          processingTimeMs: Date.now() - startTime
        }).catch(e => log.error('Log error:', e));
        break;

      case 'transfer.reversed':
        await handleTransferReversed(event.data.object as Stripe.Transfer);
        logConnectEvent(event.type, event.id, true, {
          message: `Transfer reversed: ${(event.data.object as Stripe.Transfer).id}`,
          metadata: { transferId: (event.data.object as Stripe.Transfer).id },
          processingTimeMs: Date.now() - startTime
        }).catch(e => log.error('Log error:', e));
        break;

      default:
        break;
    }

    return jsonResponse({ received: true });

  } catch (error: unknown) {
    log.error('Error:', error);

    logConnectEvent('connect_webhook_error', 'unknown', false, {
      message: 'Connect webhook processing error',
      error: 'Internal error'
    }).catch(e => log.error('Log error:', e));

    return new Response('Webhook processing error', { status: 500 });
  }
};

// Handle account.updated - sync account status to Firestore
// Supports artists, suppliers, and users (crate sellers)
async function handleAccountUpdated(account: Stripe.Account, stripeSecretKey: string, env: Record<string, unknown>) {
  // Determine entity type from metadata
  const entityType = account.metadata?.type || account.metadata?.entityType;
  const artistId = account.metadata?.artistId;
  const supplierId = account.metadata?.supplierId;
  const userId = account.metadata?.userId;

  // Route to appropriate handler based on metadata
  if (entityType === 'supplier' || supplierId) {
    await handleSupplierAccountUpdated(supplierId || account.metadata?.entityId, account, stripeSecretKey, env);
    return;
  }

  if (entityType === 'crate_seller' || entityType === 'user' || (userId && entityType !== 'artist')) {
    await handleUserAccountUpdated(userId || account.metadata?.entityId, account, stripeSecretKey, env);
    return;
  }

  // Default to artist handling (for backwards compatibility)
  if (artistId) {
    await updateArtistConnectStatus(artistId, account, stripeSecretKey, env);
    return;
  }

  // No metadata - try to find entity by stripeConnectId
  // Check artists first
  const artists = await queryCollection('artists', {
    filters: [{ field: 'stripeConnectId', op: 'EQUAL', value: account.id }],
    limit: 1
  });

  if (artists.length > 0) {
    await updateArtistConnectStatus(artists[0].id, account, stripeSecretKey, env);
    return;
  }

  // Check suppliers
  const suppliers = await queryCollection('merch-suppliers', {
    filters: [{ field: 'stripeConnectId', op: 'EQUAL', value: account.id }],
    limit: 1
  });

  if (suppliers.length > 0) {
    await handleSupplierAccountUpdated(suppliers[0].id, account, stripeSecretKey, env);
    return;
  }

  // Check users
  const users = await queryCollection('users', {
    filters: [{ field: 'stripeConnectId', op: 'EQUAL', value: account.id }],
    limit: 1
  });

  if (users.length > 0) {
    await handleUserAccountUpdated(users[0].id, account, stripeSecretKey, env);
    return;
  }

}

async function updateArtistConnectStatus(artistId: string, account: Stripe.Account, stripeSecretKey: string, env: Record<string, unknown>) {
  let status = 'onboarding';
  if (account.charges_enabled && account.payouts_enabled) {
    status = 'active';
  } else if (account.requirements?.disabled_reason) {
    status = 'restricted';
  }

  await updateDocument('artists', artistId, {
    stripeConnectStatus: status,
    stripeChargesEnabled: account.charges_enabled,
    stripePayoutsEnabled: account.payouts_enabled,
    stripeDetailsSubmitted: account.details_submitted,
    stripeLastUpdated: new Date().toISOString(),
    ...(status === 'active' ? { stripeConnectedAt: new Date().toISOString() } : {})
  });

  // If account became active, process any pending payouts (opt-in — see
  // autoTransfersEnabled; payouts are manual by operator policy)
  if (status === 'active' && autoTransfersEnabled(env)) {
    await processPendingPayouts('artist', artistId, account.id, stripeSecretKey, env);
  }
}

// Handle supplier account update
async function handleSupplierAccountUpdated(supplierId: string, account: Stripe.Account, stripeSecretKey: string, env: Record<string, unknown>) {
  if (!supplierId) {
    return;
  }

  let status = 'onboarding';
  if (account.charges_enabled && account.payouts_enabled) {
    status = 'active';
  } else if (account.requirements?.disabled_reason) {
    status = 'restricted';
  }

  await updateDocument('merch-suppliers', supplierId, {
    stripeConnectStatus: status,
    stripeChargesEnabled: account.charges_enabled,
    stripePayoutsEnabled: account.payouts_enabled,
    stripeDetailsSubmitted: account.details_submitted,
    stripeLastUpdated: new Date().toISOString(),
    ...(status === 'active' ? { stripeConnectedAt: new Date().toISOString() } : {})
  });

  // If account became active, process any pending payouts (opt-in — see
  // autoTransfersEnabled; payouts are manual by operator policy)
  if (status === 'active' && autoTransfersEnabled(env)) {
    await processPendingPayouts('supplier', supplierId, account.id, stripeSecretKey, env);
  }
}

// Handle user (crate seller) account update
async function handleUserAccountUpdated(userId: string, account: Stripe.Account, stripeSecretKey: string, env: Record<string, unknown>) {
  if (!userId) {
    return;
  }

  let status = 'onboarding';
  if (account.charges_enabled && account.payouts_enabled) {
    status = 'active';
  } else if (account.requirements?.disabled_reason) {
    status = 'restricted';
  }

  await updateDocument('users', userId, {
    stripeConnectStatus: status,
    stripeChargesEnabled: account.charges_enabled,
    stripePayoutsEnabled: account.payouts_enabled,
    stripeDetailsSubmitted: account.details_submitted,
    stripeLastUpdated: new Date().toISOString(),
    ...(status === 'active' ? { stripeConnectedAt: new Date().toISOString() } : {})
  });

  // If account became active, process any pending payouts (opt-in — see
  // autoTransfersEnabled; payouts are manual by operator policy)
  if (status === 'active' && autoTransfersEnabled(env)) {
    await processPendingPayouts('user', userId, account.id, stripeSecretKey, env);
  }
}

// (moved to @lib/stripe-connect-payouts so the admin "Pay via Stripe" action
// Handle transfer created
async function handleTransferCreated(transfer: Stripe.Transfer) {
  const payoutId = transfer.metadata?.payoutId;
  if (!payoutId) return;

  await updateDocument('payouts', payoutId, {
    stripeTransferId: transfer.id,
    status: 'completed',
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

}

// Handle transfer reversed (e.g., from refund)
async function handleTransferReversed(transfer: Stripe.Transfer) {
  const payoutId = transfer.metadata?.payoutId;
  if (!payoutId) return;

  await updateDocument('payouts', payoutId, {
    status: 'reversed',
    reversedAt: new Date().toISOString(),
    reversedAmount: transfer.amount_reversed / 100,
    updatedAt: new Date().toISOString()
  });

}
