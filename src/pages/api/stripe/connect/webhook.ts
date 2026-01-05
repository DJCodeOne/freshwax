// src/pages/api/stripe/connect/webhook.ts
// Handles Stripe Connect webhook events

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { queryCollection, updateDocument, addDocument, getDocument, initFirebaseEnv } from '../../../../lib/firebase-rest';
import { sendPayoutCompletedEmail } from '../../../../lib/payout-emails';

export const prerender = false;

// Safety limits
const MAX_PENDING_PAYOUTS = 50; // Max pending payouts to process at once

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Get Stripe keys
  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  const webhookSecret = env?.STRIPE_CONNECT_WEBHOOK_SECRET || import.meta.env.STRIPE_CONNECT_WEBHOOK_SECRET;

  if (!stripeSecretKey) {
    console.error('[Connect Webhook] Stripe secret key not configured');
    return new Response('Stripe not configured', { status: 500 });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const body = await request.text();
    const sig = request.headers.get('stripe-signature');

    if (!sig) {
      console.error('[Connect Webhook] Missing signature header - REJECTING');
      return new Response('Missing signature', { status: 401 });
    }

    let event: Stripe.Event;

    // SECURITY: Signature verification is REQUIRED
    // Only skip in local development if explicitly configured
    const isDevelopment = import.meta.env.DEV;

    if (webhookSecret) {
      try {
        event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
        console.log('[Connect Webhook] ✓ Signature verified');
      } catch (err: any) {
        console.error('[Connect Webhook] Signature verification failed:', err.message);
        return new Response(`Webhook signature verification failed: ${err.message}`, { status: 401 });
      }
    } else if (!isDevelopment) {
      // SECURITY: In production, REQUIRE webhook secret - reject without it
      console.error('[Connect Webhook] SECURITY: Webhook secret not configured in production - REJECTING');
      return new Response('Webhook not configured', { status: 500 });
    } else {
      // Only in local dev - allow without verification
      console.warn('[Connect Webhook] ⚠️ DEV MODE: Skipping signature verification');
      event = JSON.parse(body);
    }

    console.log('[Connect Webhook] Received event:', event.type);

    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account, stripeSecretKey, env);
        break;

      case 'transfer.created':
        await handleTransferCreated(event.data.object as Stripe.Transfer);
        break;

      case 'transfer.reversed':
        await handleTransferReversed(event.data.object as Stripe.Transfer);
        break;

      default:
        console.log('[Connect Webhook] Unhandled event type:', event.type);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Connect Webhook] Error:', error);
    return new Response(`Webhook error: ${error.message}`, { status: 500 });
  }
};

// Handle account.updated - sync account status to Firestore
async function handleAccountUpdated(account: Stripe.Account, stripeSecretKey: string, env: any) {
  const artistId = account.metadata?.artistId;

  if (!artistId) {
    // Try to find artist by stripeConnectId
    const artists = await queryCollection('artists', {
      filters: [{ field: 'stripeConnectId', op: 'EQUAL', value: account.id }],
      limit: 1
    });

    if (artists.length === 0) {
      console.log('[Connect Webhook] No artist found for account:', account.id);
      return;
    }

    const artist = artists[0];
    await updateArtistConnectStatus(artist.id, account, stripeSecretKey);
  } else {
    await updateArtistConnectStatus(artistId, account, stripeSecretKey);
  }
}

async function updateArtistConnectStatus(artistId: string, account: Stripe.Account, stripeSecretKey: string) {
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

  console.log('[Connect Webhook] Updated artist', artistId, 'status:', status);

  // If account became active, process any pending payouts
  if (status === 'active') {
    console.log('[Connect Webhook] Artist', artistId, 'is now active - processing pending payouts');
    await processPendingPayouts(artistId, account.id, stripeSecretKey, env);
  }
}

// Process pending payouts when artist completes onboarding
async function processPendingPayouts(artistId: string, stripeConnectId: string, stripeSecretKey: string, env: any) {
  const pendingPayouts = await queryCollection('pendingPayouts', {
    filters: [
      { field: 'artistId', op: 'EQUAL', value: artistId },
      { field: 'status', op: 'EQUAL', value: 'awaiting_connect' }
    ],
    limit: MAX_PENDING_PAYOUTS
  });

  if (pendingPayouts.length === 0) return;

  console.log('[Connect Webhook] Processing', pendingPayouts.length, 'pending payouts for artist:', artistId);

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  // Process each pending payout
  for (const pending of pendingPayouts) {
    try {
      // Mark as processing
      await updateDocument('pendingPayouts', pending.id, {
        status: 'processing',
        stripeConnectId,
        updatedAt: new Date().toISOString()
      });

      // Create transfer
      const transfer = await stripe.transfers.create({
        amount: Math.round((pending.amount || 0) * 100), // Convert to pence
        currency: pending.currency || 'gbp',
        destination: stripeConnectId,
        transfer_group: pending.orderId,
        metadata: {
          pendingPayoutId: pending.id,
          orderId: pending.orderId,
          orderNumber: pending.orderNumber,
          artistId: artistId,
          artistName: pending.artistName,
          platform: 'freshwax'
        }
      });

      // Create payout record
      await addDocument('payouts', {
        artistId: artistId,
        artistName: pending.artistName,
        artistEmail: pending.artistEmail || '',
        stripeConnectId: stripeConnectId,
        stripeTransferId: transfer.id,
        orderId: pending.orderId,
        orderNumber: pending.orderNumber,
        amount: pending.amount,
        currency: pending.currency || 'gbp',
        status: 'completed',
        fromPendingPayout: pending.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });

      // Update artist's total earnings
      const artist = await getDocument('artists', artistId);
      if (artist) {
        await updateDocument('artists', artistId, {
          totalEarnings: (artist.totalEarnings || 0) + (pending.amount || 0),
          lastPayoutAt: new Date().toISOString()
        });
      }

      // Mark pending payout as completed
      await updateDocument('pendingPayouts', pending.id, {
        status: 'completed',
        stripeTransferId: transfer.id,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      console.log('[Connect Webhook] ✓ Pending payout processed:', pending.id, 'Transfer:', transfer.id);

      // Send payout completed email notification
      if (pending.artistEmail) {
        sendPayoutCompletedEmail(
          pending.artistEmail,
          pending.artistName,
          pending.amount,
          pending.orderNumber || pending.orderId?.slice(-6).toUpperCase(),
          env
        ).catch(err => console.error('[Connect Webhook] Failed to send payout email:', err));
      }

    } catch (transferError: any) {
      console.error('[Connect Webhook] Failed to process pending payout:', pending.id, transferError.message);

      // Mark as failed for retry
      await updateDocument('pendingPayouts', pending.id, {
        status: 'retry_pending',
        failureReason: transferError.message,
        updatedAt: new Date().toISOString()
      });
    }
  }
}

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

  console.log('[Connect Webhook] Transfer created:', transfer.id, 'for payout:', payoutId);
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

  console.log('[Connect Webhook] Transfer reversed:', transfer.id, 'amount:', transfer.amount_reversed / 100);
}
