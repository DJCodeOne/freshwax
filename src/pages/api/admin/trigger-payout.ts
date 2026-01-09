// src/pages/api/admin/trigger-payout.ts
// Admin endpoint to manually trigger artist payouts for an order
// Used for: manual orders, failed auto-payouts, retries
// Supports both Stripe Connect and PayPal based on artist preference

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { getDocument, addDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { createPayout, getPayPalConfig } from '../../../lib/paypal-payouts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const bodyData = await request.json();

    // Admin auth required
    const authError = requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

    // Rate limit
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`admin-payout:${clientId}`, RateLimiters.write);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    const { orderId, artistId } = bodyData;

    if (!orderId) {
      return new Response(JSON.stringify({ error: 'orderId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[admin] Triggering payout for order:', order.orderNumber);

    // Get PayPal config
    const paypalConfig = getPayPalConfig(env);

    // Get Stripe config
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' }) : null;

    // Calculate artist payments from order items
    const items = order.items || [];
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      paypalEmail: string | null;
      stripeConnectId: string | null;
      stripeConnectStatus: string | null;
      payoutMethod: string | null;
      amount: number;
      items: string[];
    }> = {};

    for (const item of items) {
      // Skip merch items
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      // Get release to find artist
      const release = await getDocument('releases', releaseId);
      if (!release) continue;

      const itemArtistId = item.artistId || release.artistId || release.userId;
      if (!itemArtistId) continue;

      // Filter by specific artist if provided
      if (artistId && itemArtistId !== artistId) continue;

      // Get artist for payment details
      const artist = await getDocument('artists', itemArtistId);
      const paypalEmail = artist?.paypalEmail || null;
      const stripeConnectId = artist?.stripeConnectId || null;
      const stripeConnectStatus = artist?.stripeConnectStatus || null;
      const payoutMethod = artist?.payoutMethod || null;

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Calculate artist share (subtract platform fees - Bandcamp style)
      // 1% Fresh Wax fee
      const freshWaxFee = itemTotal * 0.01;
      // Payment processor fee: 1.4% + £0.20 (split across items)
      const processorFeePercent = 0.014;
      const processorFixedFee = 0.20 / items.length;
      const processorFee = (itemTotal * processorFeePercent) + processorFixedFee;
      const artistShare = itemTotal - freshWaxFee - processorFee;

      if (!artistPayments[itemArtistId]) {
        artistPayments[itemArtistId] = {
          artistId: itemArtistId,
          artistName: artist?.artistName || release.artistName || 'Unknown Artist',
          paypalEmail,
          stripeConnectId,
          stripeConnectStatus,
          payoutMethod,
          amount: 0,
          items: []
        };
      }

      artistPayments[itemArtistId].amount += artistShare;
      artistPayments[itemArtistId].items.push(item.name || 'Item');
    }

    const results: any[] = [];

    for (const payment of Object.values(artistPayments)) {
      if (payment.amount <= 0) continue;

      // Determine which payout method to use based on artist preference
      const hasStripe = payment.stripeConnectId && payment.stripeConnectStatus === 'active' && stripe;
      const hasPayPal = payment.paypalEmail && paypalConfig;

      // Check preference: explicit preference > available method
      const usePayPal = payment.payoutMethod === 'paypal' && hasPayPal;
      const useStripe = payment.payoutMethod === 'stripe' && hasStripe;
      // If no preference set, default to Stripe if available, else PayPal
      const defaultToStripe = !payment.payoutMethod && hasStripe;
      const defaultToPayPal = !payment.payoutMethod && !hasStripe && hasPayPal;

      if (!usePayPal && !useStripe && !defaultToStripe && !defaultToPayPal) {
        results.push({
          artistId: payment.artistId,
          artistName: payment.artistName,
          amount: payment.amount,
          status: 'skipped',
          reason: 'No payment method configured'
        });
        continue;
      }

      // Use PayPal
      if (usePayPal || defaultToPayPal) {
        // Deduct 2% PayPal payout fee from artist share
        const paypalPayoutFee = payment.amount * 0.02;
        const paypalAmount = payment.amount - paypalPayoutFee;

        console.log('[admin] Paying', payment.artistName, '£' + paypalAmount.toFixed(2), 'via PayPal to', payment.paypalEmail, '(2% fee: £' + paypalPayoutFee.toFixed(2) + ')');

        try {
          const payoutResult = await createPayout(paypalConfig!, {
            email: payment.paypalEmail!,
            amount: paypalAmount,
            currency: 'GBP',
            note: `Fresh Wax payout for order ${order.orderNumber}`,
            reference: `${orderId}-${payment.artistId}`
          });

          if (payoutResult.success) {
            // Record the payout
            await addDocument('payouts', {
              artistId: payment.artistId,
              artistName: payment.artistName,
              paypalEmail: payment.paypalEmail,
              paypalBatchId: payoutResult.batchId,
              paypalPayoutItemId: payoutResult.payoutItemId,
              orderId,
              orderNumber: order.orderNumber,
              amount: paypalAmount,
              paypalPayoutFee: paypalPayoutFee,
              currency: 'gbp',
              status: 'completed',
              payoutMethod: 'paypal',
              triggeredBy: 'admin',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            });

            // Update artist earnings
            const artist = await getDocument('artists', payment.artistId);
            if (artist) {
              await updateDocument('artists', payment.artistId, {
                totalEarnings: (artist.totalEarnings || 0) + paypalAmount,
                lastPayoutAt: new Date().toISOString()
              });
            }

            results.push({
              artistId: payment.artistId,
              artistName: payment.artistName,
              amount: paypalAmount,
              paypalFee: paypalPayoutFee,
              status: 'success',
              method: 'paypal',
              batchId: payoutResult.batchId
            });

            console.log('[admin] ✓ PayPal payout successful:', payoutResult.batchId);
          } else {
            results.push({
              artistId: payment.artistId,
              artistName: payment.artistName,
              amount: paypalAmount,
              status: 'failed',
              method: 'paypal',
              error: payoutResult.error
            });
          }
        } catch (err: any) {
          results.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: paypalAmount,
            status: 'error',
            method: 'paypal',
            error: err.message
          });
        }
      }
      // Use Stripe
      else if (useStripe || defaultToStripe) {
        console.log('[admin] Paying', payment.artistName, '£' + payment.amount.toFixed(2), 'via Stripe to', payment.stripeConnectId);

        try {
          const transfer = await stripe!.transfers.create({
            amount: Math.round(payment.amount * 100), // Convert to pence
            currency: 'gbp',
            destination: payment.stripeConnectId!,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber: order.orderNumber,
              artistId: payment.artistId,
              artistName: payment.artistName,
              platform: 'freshwax',
              triggeredBy: 'admin'
            }
          });

          // Record the payout
          await addDocument('payouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            stripeTransferId: transfer.id,
            stripeConnectId: payment.stripeConnectId,
            orderId,
            orderNumber: order.orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            payoutMethod: 'stripe',
            triggeredBy: 'admin',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Update artist earnings
          const artist = await getDocument('artists', payment.artistId);
          if (artist) {
            await updateDocument('artists', payment.artistId, {
              totalEarnings: (artist.totalEarnings || 0) + payment.amount,
              lastPayoutAt: new Date().toISOString()
            });
          }

          results.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: payment.amount,
            status: 'success',
            method: 'stripe',
            transferId: transfer.id
          });

          console.log('[admin] ✓ Stripe transfer successful:', transfer.id);
        } catch (err: any) {
          results.push({
            artistId: payment.artistId,
            artistName: payment.artistName,
            amount: payment.amount,
            status: 'error',
            method: 'stripe',
            error: err.message
          });
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      orderId,
      orderNumber: order.orderNumber,
      payouts: results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin] Trigger payout error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to trigger payout'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
