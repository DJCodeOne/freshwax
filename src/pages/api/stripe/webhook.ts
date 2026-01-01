// src/pages/api/stripe/webhook.ts
// Handles Stripe webhook events for product checkouts

import type { APIRoute } from 'astro';
import { createOrder } from '../../../lib/order-utils';
import { initFirebaseEnv } from '../../../lib/firebase-rest';

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

    // Verify signature if webhook secret is configured
    if (webhookSecret && signature) {
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
    } else {
      console.log('[Stripe Webhook] ⚠️ Skipping signature verification (webhookSecret:', !!webhookSecret, ', signature:', !!signature, ')');
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
      console.log('[Stripe Webhook] 📦 Creating order...');

      // Parse items from metadata
      let items: any[] = [];
      if (metadata.items_json) {
        try {
          items = JSON.parse(metadata.items_json);
          console.log('[Stripe Webhook] ✓ Parsed', items.length, 'items from metadata');
        } catch (e) {
          console.error('[Stripe Webhook] ❌ Error parsing items_json:', e);
          console.error('[Stripe Webhook] items_json value:', metadata.items_json?.substring(0, 200));
        }
      } else {
        console.log('[Stripe Webhook] ⚠️ No items_json in metadata');
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
