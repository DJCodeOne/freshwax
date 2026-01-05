// src/pages/api/stripe/webhook.ts
// Handles Stripe webhook events for product checkouts

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { createOrder } from '../../../lib/order-utils';
import { initFirebaseEnv, getDocument, queryCollection, deleteDocument, addDocument, updateDocument } from '../../../lib/firebase-rest';

export const prerender = false;

// Stripe webhook signature verification
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    // Parse the signature header
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
    const v1Signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !v1Signature) {
      console.error('[Stripe Webhook] Missing signature components');
      return false;
    }

    // Check timestamp is within tolerance (5 minutes)
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
      console.error('[Stripe Webhook] Timestamp too old');
      return false;
    }

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(signedPayload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBytes = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return expectedSignature === v1Signature;
  } catch (error) {
    console.error('[Stripe Webhook] Signature verification error:', error);
    return false;
  }
}

// Send email notification about pending earnings to artists without Stripe Connect
async function sendPendingEarningsEmail(
  artistEmail: string,
  artistName: string,
  amount: number,
  env: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      console.log('[Stripe Webhook] No email address for artist, skipping notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[Stripe Webhook] No Resend API key configured, skipping email');
      return { success: false, error: 'Email service not configured' };
    }

    const connectUrl = 'https://freshwax.co.uk/artist/account?setup=stripe';
    const formattedAmount = `£${amount.toFixed(2)}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You've got earnings waiting!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                💰 You've Made a Sale!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Great news! Someone just purchased your music on Fresh Wax. You've earned <strong style="color: #22c55e;">${formattedAmount}</strong> from this sale.
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;">
                To receive your payment, you need to connect your Stripe account. It only takes a few minutes and allows us to pay you directly.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${connectUrl}" style="display: inline-block; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Connect Stripe & Get Paid →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 14px; margin: 0 0 15px; line-height: 1.6;">
                Your earnings are held securely and will be transferred as soon as you connect your account.
              </p>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0; line-height: 1.6;">
                If you have any questions, just reply to this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0a0a0a; padding: 25px 40px; border-top: 1px solid #262626;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="font-size: 13px; margin: 0;">
                      <span style="color: #ffffff;">Fresh</span><span style="color: #dc2626;">Wax</span><span style="color: #ffffff;"> - Underground Music Platform</span>
                    </p>
                  </td>
                  <td align="right">
                    <a href="https://freshwax.co.uk" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: artistEmail,
        subject: `💰 You've made a sale on Fresh Wax! Connect Stripe to get paid`,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[Stripe Webhook] Resend error:', result);
      return { success: false, error: result.message || 'Failed to send email' };
    }

    console.log('[Stripe Webhook] Pending earnings email sent to:', artistEmail);
    return { success: true, messageId: result.id };

  } catch (error) {
    console.error('[Stripe Webhook] Error sending pending earnings email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  console.log('[Stripe Webhook] ========== WEBHOOK REQUEST RECEIVED ==========');
  console.log('[Stripe Webhook] Timestamp:', new Date().toISOString());

  try {
    const env = (locals as any)?.runtime?.env;

    // Get webhook secret
    const webhookSecret = env?.STRIPE_WEBHOOK_SECRET || import.meta.env.STRIPE_WEBHOOK_SECRET;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    console.log('[Stripe Webhook] Environment check:');
    console.log('[Stripe Webhook]   - webhookSecret exists:', !!webhookSecret);
    console.log('[Stripe Webhook]   - stripeSecretKey exists:', !!stripeSecretKey);
    console.log('[Stripe Webhook]   - env from locals:', !!env);

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    console.log('[Stripe Webhook]   - Firebase projectId:', projectId || 'MISSING');
    console.log('[Stripe Webhook]   - Firebase apiKey exists:', !!apiKey);

    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    // Get raw body for signature verification
    const payload = await request.text();
    const signature = request.headers.get('stripe-signature');

    console.log('[Stripe Webhook] Request details:');
    console.log('[Stripe Webhook]   - Payload length:', payload.length);
    console.log('[Stripe Webhook]   - Signature exists:', !!signature);
    console.log('[Stripe Webhook]   - Signature preview:', signature ? signature.substring(0, 50) + '...' : 'none');

    // SECURITY: Signature verification is REQUIRED in production
    // Only skip in development if explicitly configured
    const isDevelopment = import.meta.env.DEV;

    if (!signature) {
      console.error('[Stripe Webhook] ❌ Missing signature header - REJECTING REQUEST');
      return new Response(JSON.stringify({ error: 'Missing signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (webhookSecret) {
      console.log('[Stripe Webhook] Verifying signature...');
      const isValid = await verifyStripeSignature(payload, signature, webhookSecret);
      if (!isValid) {
        console.error('[Stripe Webhook] ❌ Invalid signature - REJECTING REQUEST');
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      console.log('[Stripe Webhook] ✓ Signature verified successfully');
    } else if (!isDevelopment) {
      // In production, REQUIRE webhook secret
      console.error('[Stripe Webhook] ❌ SECURITY: Webhook secret not configured in production - REJECTING');
      return new Response(JSON.stringify({ error: 'Webhook not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      console.log('[Stripe Webhook] ⚠️ DEV MODE: Skipping signature verification');
    }

    const event = JSON.parse(payload);
    console.log('[Stripe Webhook] Event type:', event.type);
    console.log('[Stripe Webhook] Event ID:', event.id || 'no-id');

    // Handle checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('[Stripe Webhook] ========== CHECKOUT SESSION COMPLETED ==========');
      console.log('[Stripe Webhook] Session ID:', session.id);
      console.log('[Stripe Webhook] Payment status:', session.payment_status);
      console.log('[Stripe Webhook] Payment intent:', session.payment_intent);
      console.log('[Stripe Webhook] Mode:', session.mode);
      console.log('[Stripe Webhook] Amount total:', session.amount_total);
      console.log('[Stripe Webhook] Currency:', session.currency);

      // Handle Plus subscription
      if (session.mode === 'subscription') {
        console.log('[Stripe Webhook] 👑 Processing Plus subscription...');

        const metadata = session.metadata || {};
        const userId = metadata.userId;
        const email = session.customer_email || metadata.email;

        if (userId) {
          // Calculate subscription dates
          const subscribedAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

          // Generate Plus ID
          const year = new Date().getFullYear().toString().slice(-2);
          const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
          const userHash = userId.slice(-4).toUpperCase();
          const plusId = `FWP-${year}${month}-${userHash}`;

          // Update user subscription in Firestore
          const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
          const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

          const updateData = {
            fields: {
              'subscription': {
                mapValue: {
                  fields: {
                    tier: { stringValue: 'pro' },
                    subscribedAt: { stringValue: subscribedAt },
                    expiresAt: { stringValue: expiresAt },
                    subscriptionId: { stringValue: session.subscription || session.id },
                    plusId: { stringValue: plusId },
                    paymentMethod: { stringValue: 'stripe' }
                  }
                }
              }
            }
          };

          try {
            const updateResponse = await fetch(
              `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
              }
            );

            if (updateResponse.ok) {
              console.log('[Stripe Webhook] ✓ User subscription updated:', userId);

              // Send welcome email
              try {
                const origin = new URL(request.url).origin;
                await fetch(`${origin}/api/admin/send-plus-welcome-email`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    email: email,
                    name: metadata.userName || email?.split('@')[0],
                    subscribedAt,
                    expiresAt,
                    plusId,
                    isRenewal: false
                  })
                });
                console.log('[Stripe Webhook] ✓ Welcome email sent to:', email);
              } catch (emailError) {
                console.error('[Stripe Webhook] Failed to send welcome email:', emailError);
              }
            } else {
              console.error('[Stripe Webhook] Failed to update user subscription');
            }
          } catch (updateError) {
            console.error('[Stripe Webhook] Error updating subscription:', updateError);
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Extract order data from metadata
      const metadata = session.metadata || {};
      console.log('[Stripe Webhook] Metadata keys:', Object.keys(metadata).join(', '));
      console.log('[Stripe Webhook] Metadata:', JSON.stringify(metadata, null, 2));

      // Skip if no customer email (not a valid order)
      if (!metadata.customer_email) {
        console.log('[Stripe Webhook] ⚠️ No customer email in metadata - skipping');
        console.log('[Stripe Webhook] Available metadata:', JSON.stringify(metadata));
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('[Stripe Webhook] ✓ Customer email found:', metadata.customer_email);

      // IDEMPOTENCY CHECK: Check if order already exists for this payment intent
      const paymentIntentId = session.payment_intent;
      if (paymentIntentId) {
        console.log('[Stripe Webhook] Checking for existing order with paymentIntentId:', paymentIntentId);
        try {
          const existingOrders = await queryCollection('orders', {
            filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
            limit: 1
          });

          if (existingOrders && existingOrders.length > 0) {
            console.log('[Stripe Webhook] ⚠️ Order already exists for this payment intent:', existingOrders[0].id);
            console.log('[Stripe Webhook] Order number:', existingOrders[0].orderNumber);
            console.log('[Stripe Webhook] Skipping duplicate order creation');
            return new Response(JSON.stringify({
              received: true,
              message: 'Order already exists',
              orderId: existingOrders[0].id
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          console.log('[Stripe Webhook] ✓ No existing order found - proceeding with creation');
        } catch (idempotencyErr) {
          console.error('[Stripe Webhook] ⚠️ Idempotency check failed:', idempotencyErr);
          // Continue anyway - better to risk duplicate than fail order
        }
      }

      console.log('[Stripe Webhook] 📦 Creating order...');

      // Parse items from metadata or retrieve from pending checkout
      let items: any[] = [];

      // First try items_json in metadata
      if (metadata.items_json) {
        try {
          items = JSON.parse(metadata.items_json);
          console.log('[Stripe Webhook] ✓ Parsed', items.length, 'items from metadata');
        } catch (e) {
          console.error('[Stripe Webhook] ❌ Error parsing items_json:', e);
          console.error('[Stripe Webhook] items_json value:', metadata.items_json?.substring(0, 200));
        }
      }

      // If no items in metadata, try pending checkout
      if (items.length === 0 && metadata.pending_checkout_id) {
        console.log('[Stripe Webhook] Retrieving items from pending checkout:', metadata.pending_checkout_id);
        try {
          const pendingCheckout = await getDocument('pendingCheckouts', metadata.pending_checkout_id);
          if (pendingCheckout && pendingCheckout.items) {
            items = pendingCheckout.items;
            console.log('[Stripe Webhook] ✓ Retrieved', items.length, 'items from pending checkout');

            // Clean up pending checkout
            try {
              await deleteDocument('pendingCheckouts', metadata.pending_checkout_id);
              console.log('[Stripe Webhook] ✓ Cleaned up pending checkout');
            } catch (cleanupErr) {
              console.log('[Stripe Webhook] ⚠️ Could not clean up pending checkout:', cleanupErr);
            }
          } else {
            console.log('[Stripe Webhook] ⚠️ Pending checkout not found or has no items');
          }
        } catch (pendingErr) {
          console.error('[Stripe Webhook] ❌ Error retrieving pending checkout:', pendingErr);
        }
      }

      // If still no items, log warning
      if (items.length === 0) {
        console.log('[Stripe Webhook] ⚠️ No items found in metadata or pending checkout');
      }

      // If no items in metadata, try to retrieve from session line items
      if (items.length === 0 && stripeSecretKey) {
        console.log('[Stripe Webhook] Fetching line items from Stripe API...');
        try {
          const lineItemsResponse = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
            {
              headers: {
                'Authorization': `Bearer ${stripeSecretKey}`
              }
            }
          );

          console.log('[Stripe Webhook] Line items response status:', lineItemsResponse.status);

          if (lineItemsResponse.ok) {
            const lineItemsData = await lineItemsResponse.json();
            console.log('[Stripe Webhook] Line items count:', lineItemsData.data?.length || 0);
            items = lineItemsData.data
              .filter((item: any) => item.description !== 'Processing and platform fees')
              .map((item: any, index: number) => ({
                id: `stripe_item_${index}`,
                name: item.description || 'Item',
                price: item.amount_total / 100,
                quantity: item.quantity,
                type: 'digital' // Default type
              }));
            console.log('[Stripe Webhook] ✓ Mapped', items.length, 'items from Stripe');
          } else {
            const errorText = await lineItemsResponse.text();
            console.error('[Stripe Webhook] ❌ Line items fetch failed:', errorText);
          }
        } catch (e) {
          console.error('[Stripe Webhook] ❌ Error fetching line items:', e);
        }
      }

      console.log('[Stripe Webhook] Final items count:', items.length);
      if (items.length > 0) {
        console.log('[Stripe Webhook] First item:', JSON.stringify(items[0]));
      }

      // Build shipping info from Stripe shipping details
      let shipping = null;
      if (session.shipping_details) {
        const addr = session.shipping_details.address;
        shipping = {
          address1: addr.line1 || '',
          address2: addr.line2 || '',
          city: addr.city || '',
          county: addr.state || '',
          postcode: addr.postal_code || '',
          country: getCountryName(addr.country)
        };
        console.log('[Stripe Webhook] ✓ Shipping address:', shipping.city, shipping.postcode);
      } else {
        console.log('[Stripe Webhook] No shipping details (digital order)');
      }

      console.log('[Stripe Webhook] Calling createOrder with:');
      console.log('[Stripe Webhook]   - Customer:', metadata.customer_email);
      console.log('[Stripe Webhook]   - Items:', items.length);
      console.log('[Stripe Webhook]   - Total:', session.amount_total / 100);
      console.log('[Stripe Webhook]   - PaymentIntent:', session.payment_intent);

      // Create order using shared utility
      const result = await createOrder({
        orderData: {
          customer: {
            email: metadata.customer_email,
            firstName: metadata.customer_firstName || 'Customer',
            lastName: metadata.customer_lastName || '',
            phone: metadata.customer_phone || '',
            userId: metadata.customer_userId || undefined
          },
          shipping,
          items,
          totals: {
            subtotal: parseFloat(metadata.subtotal) || (session.amount_total / 100),
            shipping: parseFloat(metadata.shipping) || 0,
            serviceFees: parseFloat(metadata.serviceFees) || 0,
            total: session.amount_total / 100
          },
          hasPhysicalItems: metadata.hasPhysicalItems === 'true',
          paymentMethod: 'stripe',
          paymentIntentId: session.payment_intent
        },
        env
      });

      console.log('[Stripe Webhook] createOrder returned:', JSON.stringify(result));

      if (!result.success) {
        console.error('[Stripe Webhook] ❌ ORDER CREATION FAILED');
        console.error('[Stripe Webhook] Error:', result.error);
        return new Response(JSON.stringify({
          error: result.error || 'Failed to create order'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('[Stripe Webhook] ✅ ORDER CREATED SUCCESSFULLY');
      console.log('[Stripe Webhook] Order Number:', result.orderNumber);
      console.log('[Stripe Webhook] Order ID:', result.orderId);

      // Process artist payments via Stripe Connect
      if (result.orderId && stripeSecretKey) {
        console.log('[Stripe Webhook] 💰 Processing artist payments...');
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          stripeSecretKey,
          env
        });
      }

      console.log('[Stripe Webhook] ========== WEBHOOK COMPLETE ==========');
    }

    // Handle payment_intent.succeeded (backup for session complete)
    if (event.type === 'payment_intent.succeeded') {
      console.log('[Stripe Webhook] Payment intent succeeded:', event.data.object.id);
      // Order should already be created by checkout.session.completed
    }

    // Handle subscription renewal (invoice.payment_succeeded for recurring payments)
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      console.log('[Stripe Webhook] ========== INVOICE PAYMENT SUCCEEDED ==========');
      console.log('[Stripe Webhook] Invoice ID:', invoice.id);
      console.log('[Stripe Webhook] Billing reason:', invoice.billing_reason);
      console.log('[Stripe Webhook] Subscription:', invoice.subscription);

      // Only process subscription renewals, not initial payments
      if (invoice.billing_reason === 'subscription_cycle' && invoice.subscription) {
        console.log('[Stripe Webhook] 👑 Processing Plus subscription RENEWAL...');

        // Get subscription details from Stripe
        const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
        if (stripeSecretKey) {
          try {
            const subResponse = await fetch(
              `https://api.stripe.com/v1/subscriptions/${invoice.subscription}`,
              {
                headers: { 'Authorization': `Bearer ${stripeSecretKey}` }
              }
            );
            const subscription = await subResponse.json();

            if (subscription.metadata?.userId) {
              const userId = subscription.metadata.userId;
              const email = invoice.customer_email || subscription.metadata.email;

              // Calculate new expiry (extend by 1 year from current expiry or now)
              const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
              const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

              // Get current user to check existing expiry
              const userResponse = await fetch(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?key=${FIREBASE_API_KEY}`
              );
              const userData = await userResponse.json();

              let baseDate = new Date();
              if (userData.fields?.subscription?.mapValue?.fields?.expiresAt?.stringValue) {
                const currentExpiry = new Date(userData.fields.subscription.mapValue.fields.expiresAt.stringValue);
                if (currentExpiry > baseDate) {
                  baseDate = currentExpiry; // Extend from current expiry if not yet expired
                }
              }

              const newExpiry = new Date(baseDate);
              newExpiry.setFullYear(newExpiry.getFullYear() + 1); // Add 1 year

              // Update subscription expiry
              const updateData = {
                fields: {
                  'subscription': {
                    mapValue: {
                      fields: {
                        tier: { stringValue: 'pro' },
                        expiresAt: { stringValue: newExpiry.toISOString() },
                        lastRenewal: { stringValue: new Date().toISOString() },
                        subscriptionId: { stringValue: invoice.subscription },
                        paymentMethod: { stringValue: 'stripe' }
                      }
                    }
                  }
                }
              };

              // Preserve existing fields
              if (userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue) {
                updateData.fields.subscription.mapValue.fields.subscribedAt =
                  userData.fields.subscription.mapValue.fields.subscribedAt;
              }
              if (userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue) {
                updateData.fields.subscription.mapValue.fields.plusId =
                  userData.fields.subscription.mapValue.fields.plusId;
              }

              const updateResponse = await fetch(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(updateData)
                }
              );

              if (updateResponse.ok) {
                console.log('[Stripe Webhook] ✓ Subscription renewed for:', userId);
                console.log('[Stripe Webhook] New expiry:', newExpiry.toISOString());

                // Send renewal confirmation email
                try {
                  const origin = new URL(request.url).origin;
                  await fetch(`${origin}/api/admin/send-plus-welcome-email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email: email,
                      name: subscription.metadata.userName || email?.split('@')[0],
                      subscribedAt: userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue,
                      expiresAt: newExpiry.toISOString(),
                      plusId: userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue,
                      isRenewal: true
                    })
                  });
                  console.log('[Stripe Webhook] ✓ Renewal email sent to:', email);
                } catch (emailError) {
                  console.error('[Stripe Webhook] Failed to send renewal email:', emailError);
                }
              } else {
                console.error('[Stripe Webhook] Failed to update subscription on renewal');
              }
            } else {
              console.log('[Stripe Webhook] No userId in subscription metadata');
            }
          } catch (subError) {
            console.error('[Stripe Webhook] Error processing renewal:', subError);
          }
        }
      }
    }

    // Handle subscription cancelled/expired
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      console.log('[Stripe Webhook] ========== SUBSCRIPTION CANCELLED ==========');
      console.log('[Stripe Webhook] Subscription ID:', subscription.id);

      // User's subscription has been cancelled - they'll naturally lose Plus when expiresAt passes
      // The getEffectiveTier() function handles this automatically
      // Optionally, we could immediately downgrade or send a cancellation email here
    }

    // Handle dispute created - reverse transfers to recover funds from artists
    if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      console.log('[Stripe Webhook] ========== DISPUTE CREATED ==========');
      console.log('[Stripe Webhook] Dispute ID:', dispute.id);
      console.log('[Stripe Webhook] Charge ID:', dispute.charge);
      console.log('[Stripe Webhook] Amount:', dispute.amount / 100, dispute.currency?.toUpperCase());
      console.log('[Stripe Webhook] Reason:', dispute.reason);

      await handleDisputeCreated(dispute, stripeSecretKey);
    }

    // Handle dispute closed - track outcome
    if (event.type === 'charge.dispute.closed') {
      const dispute = event.data.object;
      console.log('[Stripe Webhook] ========== DISPUTE CLOSED ==========');
      console.log('[Stripe Webhook] Dispute ID:', dispute.id);
      console.log('[Stripe Webhook] Status:', dispute.status);

      await handleDisputeClosed(dispute, stripeSecretKey);
    }

    // Handle refund - reverse artist transfers proportionally
    if (event.type === 'charge.refunded') {
      const charge = event.data.object as any;
      console.log('[Stripe Webhook] ========== REFUND PROCESSED ==========');
      console.log('[Stripe Webhook] Charge ID:', charge.id);
      console.log('[Stripe Webhook] Amount refunded:', charge.amount_refunded / 100, charge.currency?.toUpperCase());
      console.log('[Stripe Webhook] Total amount:', charge.amount / 100, charge.currency?.toUpperCase());

      await handleRefund(charge, stripeSecretKey);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Stripe Webhook] Error:', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function getCountryName(code: string): string {
  const countryMap: { [key: string]: string } = {
    'GB': 'United Kingdom',
    'IE': 'Ireland',
    'DE': 'Germany',
    'FR': 'France',
    'NL': 'Netherlands',
    'BE': 'Belgium',
    'US': 'United States',
    'CA': 'Canada',
    'AU': 'Australia'
  };
  return countryMap[code] || code;
}

// Process artist payments via Stripe Connect
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Group items by artist (using releaseId to look up artist)
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      stripeConnectId: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Cache for release lookups
    const releaseCache: Record<string, any> = {};

    for (const item of items) {
      // Skip merch items - they go to suppliers, not artists
      // Vinyl and digital sales go to artists
      if (item.type === 'merch') continue;

      // Get release data to find artist
      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      let release = releaseCache[releaseId];
      if (!release) {
        release = await getDocument('releases', releaseId);
        if (release) {
          releaseCache[releaseId] = release;
        }
      }

      if (!release) continue;

      // Get artist data - prefer artistId from cart item, fallback to release
      const artistId = item.artistId || release.artistId || release.userId;
      if (!artistId) continue;

      // Look up artist document for stripeConnectId
      let artist = null;
      try {
        artist = await getDocument('artists', artistId);
      } catch (e) {
        console.log('[Stripe Webhook] Could not find artist:', artistId);
      }

      // Calculate artist share (100% of item price - fees are added on top for customer)
      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // Group by artist
      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          stripeConnectId: artist?.stripeConnectId || null,
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += itemTotal;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    console.log('[Stripe Webhook] Artist payments to process:', Object.keys(artistPayments).length);

    // Process each artist payment
    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];

      if (payment.amount <= 0) continue;

      console.log('[Stripe Webhook] Processing payment for', payment.artistName, ':', payment.amount, 'GBP');

      if (payment.stripeConnectId) {
        // Create transfer to connected account
        try {
          const transfer = await stripe.transfers.create({
            amount: Math.round(payment.amount * 100), // Convert to pence
            currency: 'gbp',
            destination: payment.stripeConnectId,
            transfer_group: orderId,
            metadata: {
              orderId,
              orderNumber,
              artistId: payment.artistId,
              artistName: payment.artistName,
              platform: 'freshwax'
            }
          });

          // Record successful payout
          await addDocument('payouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            artistEmail: payment.artistEmail,
            stripeConnectId: payment.stripeConnectId,
            stripeTransferId: transfer.id,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'completed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Update artist's total earnings
          const artist = await getDocument('artists', payment.artistId);
          if (artist) {
            await updateDocument('artists', payment.artistId, {
              totalEarnings: (artist.totalEarnings || 0) + payment.amount,
              lastPayoutAt: new Date().toISOString()
            });
          }

          console.log('[Stripe Webhook] ✓ Transfer created:', transfer.id, 'for', payment.artistName);

        } catch (transferError: any) {
          console.error('[Stripe Webhook] Transfer failed for', payment.artistName, ':', transferError.message);

          // Store as pending for retry
          await addDocument('pendingPayouts', {
            artistId: payment.artistId,
            artistName: payment.artistName,
            artistEmail: payment.artistEmail,
            orderId,
            orderNumber,
            amount: payment.amount,
            currency: 'gbp',
            status: 'retry_pending',
            failureReason: transferError.message,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      } else {
        // Artist not connected - store as pending
        console.log('[Stripe Webhook] Artist', payment.artistName, 'not connected - storing pending payout');

        const pendingPayoutResult = await addDocument('pendingPayouts', {
          artistId: payment.artistId,
          artistName: payment.artistName,
          artistEmail: payment.artistEmail,
          orderId,
          orderNumber,
          amount: payment.amount,
          currency: 'gbp',
          status: 'awaiting_connect',
          notificationSent: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Update artist's pending balance
        const artist = await getDocument('artists', payment.artistId);
        if (artist) {
          await updateDocument('artists', payment.artistId, {
            pendingBalance: (artist.pendingBalance || 0) + payment.amount
          });
        }

        // Send email notification about pending earnings
        if (payment.artistEmail) {
          const emailResult = await sendPendingEarningsEmail(
            payment.artistEmail,
            payment.artistName,
            payment.amount,
            env
          );

          // Update pending payout with notification status
          if (emailResult.success && pendingPayoutResult.id) {
            await updateDocument('pendingPayouts', pendingPayoutResult.id, {
              notificationSent: true,
              notificationSentAt: new Date().toISOString()
            });
            console.log('[Stripe Webhook] ✓ Pending earnings email sent to', payment.artistEmail);
          } else if (pendingPayoutResult.id) {
            console.log('[Stripe Webhook] Email not sent:', emailResult.error);
          }
        }
      }
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error processing artist payments:', error.message);
    // Don't throw - order was created, payments can be retried
  }
}

// Handle dispute created - reverse transfers to recover funds from artists
async function handleDisputeCreated(dispute: any, stripeSecretKey: string) {
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    const disputeAmount = dispute.amount / 100; // Convert from cents to GBP

    console.log('[Stripe Webhook] Processing dispute for charge:', chargeId);

    // Get the charge to find the payment intent and transfer group
    const charge = await stripe.charges.retrieve(chargeId, {
      expand: ['transfer_group', 'payment_intent']
    });

    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    // Find the order by payment intent
    let order = null;
    if (paymentIntentId) {
      const orders = await queryCollection('orders', {
        filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
        limit: 1
      });
      order = orders[0];
    }

    // Find related transfers by transfer_group (orderId)
    const transferGroup = charge.transfer_group || order?.id;
    let transfersReversed: any[] = [];
    let totalRecovered = 0;

    if (transferGroup) {
      // List all transfers in this transfer group
      const transfers = await stripe.transfers.list({
        transfer_group: transferGroup,
        limit: 100
      });

      console.log('[Stripe Webhook] Found', transfers.data.length, 'transfers to potentially reverse');

      // Reverse each transfer to recover funds
      for (const transfer of transfers.data) {
        // Skip if already fully reversed
        if (transfer.reversed) {
          console.log('[Stripe Webhook] Transfer already reversed:', transfer.id);
          continue;
        }

        try {
          // Reverse the transfer
          const reversal = await stripe.transfers.createReversal(transfer.id, {
            description: `Dispute ${dispute.id} - ${dispute.reason}`,
            metadata: {
              disputeId: dispute.id,
              reason: dispute.reason,
              chargeId: chargeId
            }
          });

          const reversedAmount = reversal.amount / 100;
          totalRecovered += reversedAmount;

          transfersReversed.push({
            transferId: transfer.id,
            reversalId: reversal.id,
            amount: reversedAmount,
            artistId: transfer.metadata?.artistId,
            artistName: transfer.metadata?.artistName
          });

          console.log('[Stripe Webhook] ✓ Reversed transfer:', transfer.id, 'Amount:', reversedAmount);

          // Update the payout record
          const payouts = await queryCollection('payouts', {
            filters: [{ field: 'stripeTransferId', op: 'EQUAL', value: transfer.id }],
            limit: 1
          });

          if (payouts.length > 0) {
            await updateDocument('payouts', payouts[0].id, {
              status: 'reversed',
              reversedAt: new Date().toISOString(),
              reversedAmount: reversedAmount,
              reversalReason: `Dispute: ${dispute.reason}`,
              disputeId: dispute.id,
              updatedAt: new Date().toISOString()
            });
          }

          // Update artist's total earnings
          const artistId = transfer.metadata?.artistId;
          if (artistId) {
            const artist = await getDocument('artists', artistId);
            if (artist) {
              await updateDocument('artists', artistId, {
                totalEarnings: Math.max(0, (artist.totalEarnings || 0) - reversedAmount),
                updatedAt: new Date().toISOString()
              });
            }
          }

        } catch (reversalError: any) {
          console.error('[Stripe Webhook] Failed to reverse transfer:', transfer.id, reversalError.message);
        }
      }
    }

    // Create dispute record in Firestore
    await addDocument('disputes', {
      stripeDisputeId: dispute.id,
      stripeChargeId: chargeId,
      stripePaymentIntentId: paymentIntentId || null,
      orderId: order?.id || transferGroup || null,
      orderNumber: order?.orderNumber || null,
      amount: disputeAmount,
      currency: dispute.currency || 'gbp',
      reason: dispute.reason,
      status: 'open',
      evidenceDueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
      transfersReversed: transfersReversed,
      amountRecovered: totalRecovered,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    console.log('[Stripe Webhook] ✓ Dispute recorded. Recovered:', totalRecovered, 'GBP from', transfersReversed.length, 'transfers');

  } catch (error: any) {
    console.error('[Stripe Webhook] Error handling dispute:', error.message);
    // Still record the dispute even if transfer reversal failed
    await addDocument('disputes', {
      stripeDisputeId: dispute.id,
      stripeChargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id,
      amount: dispute.amount / 100,
      currency: dispute.currency || 'gbp',
      reason: dispute.reason,
      status: 'open',
      error: error.message,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

// Handle dispute closed - update status and track outcome
async function handleDisputeClosed(dispute: any, stripeSecretKey: string) {
  try {
    // Find the dispute record
    const disputes = await queryCollection('disputes', {
      filters: [{ field: 'stripeDisputeId', op: 'EQUAL', value: dispute.id }],
      limit: 1
    });

    if (disputes.length === 0) {
      console.log('[Stripe Webhook] Dispute record not found:', dispute.id);
      return;
    }

    const disputeRecord = disputes[0];
    const outcome = dispute.status === 'won' ? 'won' : 'lost';

    // Calculate net impact
    let netImpact = 0;
    let retransfersCreated: any[] = [];

    if (outcome === 'lost') {
      // We lost - platform absorbs the loss minus any recovered amount
      netImpact = disputeRecord.amount - (disputeRecord.amountRecovered || 0);
    } else if (outcome === 'won' && disputeRecord.transfersReversed?.length > 0) {
      // We won - re-transfer to artists since they shouldn't lose money
      console.log('[Stripe Webhook] Dispute won - re-transferring to artists');

      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

      for (const reversedTransfer of disputeRecord.transfersReversed) {
        try {
          // Get the artist's current Stripe Connect ID
          const artist = await getDocument('artists', reversedTransfer.artistId);

          if (!artist?.stripeConnectId || artist.stripeConnectStatus !== 'active') {
            console.log('[Stripe Webhook] Artist', reversedTransfer.artistId, 'no longer has active Connect - storing as pending');

            // Store as pending payout
            await addDocument('pendingPayouts', {
              artistId: reversedTransfer.artistId,
              artistName: reversedTransfer.artistName,
              artistEmail: artist?.email || '',
              orderId: disputeRecord.orderId,
              orderNumber: disputeRecord.orderNumber || '',
              amount: reversedTransfer.amount,
              currency: 'gbp',
              status: 'awaiting_connect',
              reason: 'dispute_won_retransfer',
              originalTransferId: reversedTransfer.transferId,
              disputeId: dispute.id,
              notificationSent: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            continue;
          }

          // Create new transfer
          const transfer = await stripe.transfers.create({
            amount: Math.round(reversedTransfer.amount * 100),
            currency: 'gbp',
            destination: artist.stripeConnectId,
            transfer_group: disputeRecord.orderId,
            metadata: {
              orderId: disputeRecord.orderId,
              orderNumber: disputeRecord.orderNumber || '',
              artistId: reversedTransfer.artistId,
              artistName: reversedTransfer.artistName,
              reason: 'dispute_won_retransfer',
              originalTransferId: reversedTransfer.transferId,
              disputeId: dispute.id,
              platform: 'freshwax'
            }
          });

          retransfersCreated.push({
            newTransferId: transfer.id,
            originalTransferId: reversedTransfer.transferId,
            amount: reversedTransfer.amount,
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName
          });

          // Create payout record
          await addDocument('payouts', {
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName,
            artistEmail: artist.email || '',
            stripeConnectId: artist.stripeConnectId,
            stripeTransferId: transfer.id,
            orderId: disputeRecord.orderId,
            orderNumber: disputeRecord.orderNumber || '',
            amount: reversedTransfer.amount,
            currency: 'gbp',
            status: 'completed',
            reason: 'dispute_won_retransfer',
            originalTransferId: reversedTransfer.transferId,
            disputeId: dispute.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Restore artist's earnings
          await updateDocument('artists', reversedTransfer.artistId, {
            totalEarnings: (artist.totalEarnings || 0) + reversedTransfer.amount,
            updatedAt: new Date().toISOString()
          });

          console.log('[Stripe Webhook] ✓ Re-transferred', reversedTransfer.amount, 'GBP to', reversedTransfer.artistName);

        } catch (retransferError: any) {
          console.error('[Stripe Webhook] Failed to re-transfer to artist:', reversedTransfer.artistId, retransferError.message);

          // Store as pending for retry
          await addDocument('pendingPayouts', {
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName,
            orderId: disputeRecord.orderId,
            orderNumber: disputeRecord.orderNumber || '',
            amount: reversedTransfer.amount,
            currency: 'gbp',
            status: 'retry_pending',
            reason: 'dispute_won_retransfer',
            originalTransferId: reversedTransfer.transferId,
            disputeId: dispute.id,
            failureReason: retransferError.message,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      }

      netImpact = 0; // We recovered the funds and paid artists
    }

    await updateDocument('disputes', disputeRecord.id, {
      status: outcome === 'won' ? 'won' : 'lost',
      outcome: outcome,
      resolvedAt: new Date().toISOString(),
      netImpact: netImpact,
      retransfersCreated: retransfersCreated.length > 0 ? retransfersCreated : null,
      retransferCount: retransfersCreated.length,
      updatedAt: new Date().toISOString()
    });

    console.log('[Stripe Webhook] ✓ Dispute', dispute.id, 'closed with outcome:', outcome);
    if (retransfersCreated.length > 0) {
      console.log('[Stripe Webhook]   Re-transfers created:', retransfersCreated.length);
    }
    if (netImpact > 0) {
      console.log('[Stripe Webhook]   Net platform loss:', netImpact, 'GBP');
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error handling dispute closure:', error.message);
  }
}

// Handle refund - reverse artist transfers proportionally
async function handleRefund(charge: any, stripeSecretKey: string) {
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    if (!paymentIntentId) {
      console.log('[Stripe Webhook] No payment intent on charge, skipping refund handling');
      return;
    }

    // Find the order by payment intent
    const orders = await queryCollection('orders', {
      filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
      limit: 1
    });

    if (orders.length === 0) {
      console.log('[Stripe Webhook] No order found for payment intent:', paymentIntentId);
      return;
    }

    const order = orders[0];
    const orderId = order.id;

    // Calculate refund percentage
    const totalAmount = charge.amount / 100; // Total charge in GBP
    const refundedAmount = charge.amount_refunded / 100; // Amount refunded in GBP
    const refundPercentage = refundedAmount / totalAmount;
    const isFullRefund = refundPercentage >= 0.99; // Allow for rounding

    console.log('[Stripe Webhook] Order:', orderId);
    console.log('[Stripe Webhook] Refund percentage:', (refundPercentage * 100).toFixed(1) + '%');
    console.log('[Stripe Webhook] Full refund:', isFullRefund);

    // Check if we've already processed refunds for this charge
    const existingRefunds = await queryCollection('refunds', {
      filters: [{ field: 'stripeChargeId', op: 'EQUAL', value: charge.id }],
      limit: 1
    });

    // Calculate how much we've already refunded
    let previouslyRefunded = 0;
    if (existingRefunds.length > 0) {
      previouslyRefunded = existingRefunds.reduce((sum: number, r: any) => sum + (r.amountRefunded || 0), 0);
    }

    // Calculate the new refund amount (incremental)
    const newRefundAmount = refundedAmount - previouslyRefunded;

    if (newRefundAmount <= 0) {
      console.log('[Stripe Webhook] No new refund amount to process');
      return;
    }

    const newRefundPercentage = newRefundAmount / totalAmount;

    console.log('[Stripe Webhook] New refund amount:', newRefundAmount, 'GBP');

    // Find all completed payouts for this order
    const payouts = await queryCollection('payouts', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: 'status', op: 'EQUAL', value: 'completed' }
      ],
      limit: 50
    });

    if (payouts.length === 0) {
      console.log('[Stripe Webhook] No completed payouts found for order:', orderId);

      // Check for pending payouts and cancel them
      const pendingPayouts = await queryCollection('pendingPayouts', {
        filters: [
          { field: 'orderId', op: 'EQUAL', value: orderId },
          { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
        ],
        limit: 50
      });

      for (const pending of pendingPayouts) {
        await updateDocument('pendingPayouts', pending.id, {
          status: 'cancelled',
          cancelledReason: 'order_refunded',
          refundPercentage: refundPercentage,
          updatedAt: new Date().toISOString()
        });
        console.log('[Stripe Webhook] Cancelled pending payout:', pending.id);
      }

      // Record the refund even without transfers to reverse
      await addDocument('refunds', {
        stripeChargeId: charge.id,
        stripePaymentIntentId: paymentIntentId,
        orderId: orderId,
        orderNumber: order.orderNumber || '',
        totalAmount: totalAmount,
        amountRefunded: refundedAmount,
        refundPercentage: refundPercentage,
        isFullRefund: isFullRefund,
        transfersReversed: [],
        pendingPayoutsCancelled: pendingPayouts.length,
        createdAt: new Date().toISOString()
      });

      return;
    }

    console.log('[Stripe Webhook] Found', payouts.length, 'payouts to process');

    // Reverse transfers proportionally
    let transfersReversed: any[] = [];
    let totalReversed = 0;

    for (const payout of payouts) {
      if (!payout.stripeTransferId) continue;

      // Calculate proportional reversal amount
      const reversalAmount = Math.round(payout.amount * newRefundPercentage * 100) / 100;

      if (reversalAmount <= 0) continue;

      try {
        // Get the transfer to check current state
        const transfer = await stripe.transfers.retrieve(payout.stripeTransferId);

        // Calculate how much can still be reversed
        const alreadyReversed = (transfer.amount_reversed || 0) / 100;
        const transferAmount = transfer.amount / 100;
        const remainingReversible = transferAmount - alreadyReversed;

        if (remainingReversible <= 0) {
          console.log('[Stripe Webhook] Transfer already fully reversed:', payout.stripeTransferId);
          continue;
        }

        // Don't reverse more than what's available
        const actualReversalAmount = Math.min(reversalAmount, remainingReversible);
        const reversalAmountCents = Math.round(actualReversalAmount * 100);

        if (reversalAmountCents <= 0) continue;

        // Create transfer reversal
        const reversal = await stripe.transfers.createReversal(payout.stripeTransferId, {
          amount: reversalAmountCents,
          metadata: {
            reason: 'customer_refund',
            orderId: orderId,
            chargeId: charge.id,
            refundPercentage: (newRefundPercentage * 100).toFixed(1)
          }
        });

        transfersReversed.push({
          transferId: payout.stripeTransferId,
          reversalId: reversal.id,
          amount: actualReversalAmount,
          artistId: payout.artistId,
          artistName: payout.artistName
        });

        totalReversed += actualReversalAmount;

        console.log('[Stripe Webhook] ✓ Reversed', actualReversalAmount, 'GBP from', payout.artistName);

        // Update payout record
        const currentReversed = payout.reversedAmount || 0;
        const newTotalReversed = currentReversed + actualReversalAmount;
        const isFullyReversed = newTotalReversed >= payout.amount * 0.99;

        await updateDocument('payouts', payout.id, {
          status: isFullyReversed ? 'reversed' : 'partially_reversed',
          reversedAmount: newTotalReversed,
          reversedAt: new Date().toISOString(),
          reversalReason: 'customer_refund',
          refundChargeId: charge.id,
          updatedAt: new Date().toISOString()
        });

        // Update artist's total earnings
        if (payout.artistId) {
          const artist = await getDocument('artists', payout.artistId);
          if (artist) {
            await updateDocument('artists', payout.artistId, {
              totalEarnings: Math.max(0, (artist.totalEarnings || 0) - actualReversalAmount),
              updatedAt: new Date().toISOString()
            });
          }
        }

      } catch (reversalError: any) {
        console.error('[Stripe Webhook] Failed to reverse transfer:', payout.stripeTransferId, reversalError.message);

        // Record failed reversal for manual review
        transfersReversed.push({
          transferId: payout.stripeTransferId,
          error: reversalError.message,
          amount: reversalAmount,
          artistId: payout.artistId,
          artistName: payout.artistName,
          failed: true
        });
      }
    }

    // Also cancel any pending payouts
    const pendingPayouts = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
      ],
      limit: 50
    });

    for (const pending of pendingPayouts) {
      if (isFullRefund) {
        // Full refund - cancel entirely
        await updateDocument('pendingPayouts', pending.id, {
          status: 'cancelled',
          cancelledReason: 'order_refunded',
          updatedAt: new Date().toISOString()
        });
      } else {
        // Partial refund - reduce amount proportionally
        const reducedAmount = pending.amount * (1 - newRefundPercentage);
        await updateDocument('pendingPayouts', pending.id, {
          amount: Math.round(reducedAmount * 100) / 100,
          originalAmount: pending.amount,
          reducedByRefund: true,
          refundPercentage: newRefundPercentage,
          updatedAt: new Date().toISOString()
        });
      }
    }

    // Create refund record
    await addDocument('refunds', {
      stripeChargeId: charge.id,
      stripePaymentIntentId: paymentIntentId,
      orderId: orderId,
      orderNumber: order.orderNumber || '',
      totalAmount: totalAmount,
      amountRefunded: refundedAmount,
      newRefundAmount: newRefundAmount,
      refundPercentage: refundPercentage,
      isFullRefund: isFullRefund,
      transfersReversed: transfersReversed,
      totalReversed: totalReversed,
      pendingPayoutsAffected: pendingPayouts.length,
      createdAt: new Date().toISOString()
    });

    // Update order status
    await updateDocument('orders', orderId, {
      refundStatus: isFullRefund ? 'fully_refunded' : 'partially_refunded',
      refundAmount: refundedAmount,
      refundedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    console.log('[Stripe Webhook] ✓ Refund processed. Reversed', totalReversed, 'GBP from', transfersReversed.filter((t: any) => !t.failed).length, 'transfers');

  } catch (error: any) {
    console.error('[Stripe Webhook] Error handling refund:', error.message);
  }
}
