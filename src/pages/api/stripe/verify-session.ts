// src/pages/api/stripe/verify-session.ts
// Verifies a Stripe checkout session and returns order info
// Also creates order as fallback if webhook hasn't processed it

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { createOrder } from '../../../lib/order-utils';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  console.log('[verify-session] ========== VERIFY SESSION REQUEST ==========');
  console.log('[verify-session] Timestamp:', new Date().toISOString());

  try {
    const sessionId = url.searchParams.get('session_id');
    console.log('[verify-session] Session ID:', sessionId || 'MISSING');

    if (!sessionId) {
      console.log('[verify-session] ❌ No session_id provided');
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing session_id'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = (locals as any)?.runtime?.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    console.log('[verify-session] Environment check:');
    console.log('[verify-session]   - env from locals:', !!env);
    console.log('[verify-session]   - stripeSecretKey exists:', !!stripeSecretKey);

    if (!stripeSecretKey) {
      console.log('[verify-session] ❌ Stripe not configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'Stripe not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Retrieve the session from Stripe
    console.log('[verify-session] Fetching session from Stripe...');
    const sessionResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      }
    );

    console.log('[verify-session] Stripe response status:', sessionResponse.status);

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      console.log('[verify-session] ❌ Invalid session response:', errorText);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid session'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const session = await sessionResponse.json();
    console.log('[verify-session] Session retrieved:');
    console.log('[verify-session]   - payment_status:', session.payment_status);
    console.log('[verify-session]   - status:', session.status);
    console.log('[verify-session]   - payment_intent:', session.payment_intent);
    console.log('[verify-session]   - amount_total:', session.amount_total);

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      console.log('[verify-session] ❌ Payment not completed, status:', session.payment_status);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment not completed',
        status: session.payment_status
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[verify-session] ✓ Payment status is PAID');

    // Initialize Firebase to find the order
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

    console.log('[verify-session] Firebase config:');
    console.log('[verify-session]   - projectId:', projectId);
    console.log('[verify-session]   - apiKey exists:', !!apiKey);

    // Initialize with full env if available, otherwise use extracted values
    if (env) {
      initFirebaseEnv(env);
      console.log('[verify-session] Initialized Firebase from env');
    } else {
      initFirebaseEnv({
        FIREBASE_PROJECT_ID: projectId,
        FIREBASE_API_KEY: apiKey,
      });
      console.log('[verify-session] Initialized Firebase from fallback');
    }

    // Try to find order by payment intent ID
    const paymentIntentId = session.payment_intent;
    console.log('[verify-session] Looking for existing order with paymentIntentId:', paymentIntentId);

    if (paymentIntentId) {
      // Query Firestore for order with this payment intent
      const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

      console.log('[verify-session] Querying orders collection...');
      const queryResponse = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'orders' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'paymentIntentId' },
                op: 'EQUAL',
                value: { stringValue: paymentIntentId }
              }
            },
            limit: 1
          }
        })
      });

      console.log('[verify-session] Order query response status:', queryResponse.status);

      if (queryResponse.ok) {
        const results = await queryResponse.json();
        console.log('[verify-session] Query results count:', results?.length || 0);

        if (results && results[0]?.document) {
          const docPath = results[0].document.name;
          const orderId = docPath.split('/').pop();

          console.log('[verify-session] ✅ EXISTING ORDER FOUND');
          console.log('[verify-session] Order ID:', orderId);
          console.log('[verify-session] ========== VERIFY SESSION COMPLETE ==========');

          return new Response(JSON.stringify({
            success: true,
            orderId,
            paymentStatus: session.payment_status
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          console.log('[verify-session] No existing order found, will create as fallback');
        }
      } else {
        const errorText = await queryResponse.text();
        console.log('[verify-session] ⚠️ Order query failed:', errorText);
      }
    } else {
      console.log('[verify-session] ⚠️ No paymentIntentId in session');
    }

    // Order not found - wait a bit more and check again (webhook might be processing)
    console.log('[verify-session] No order found yet, waiting for webhook to complete...');
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 more seconds

    // Check again after waiting
    if (paymentIntentId) {
      console.log('[verify-session] Re-checking for order after wait...');
      const retryResponse = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'orders' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'paymentIntentId' },
                op: 'EQUAL',
                value: { stringValue: paymentIntentId }
              }
            },
            limit: 1
          }
        })
      });

      if (retryResponse.ok) {
        const retryResults = await retryResponse.json();
        if (retryResults && retryResults[0]?.document) {
          const docPath = retryResults[0].document.name;
          const orderId = docPath.split('/').pop();
          console.log('[verify-session] ✅ ORDER FOUND ON RETRY');
          console.log('[verify-session] Order ID:', orderId);
          return new Response(JSON.stringify({
            success: true,
            orderId,
            paymentStatus: session.payment_status
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // Order still not found - create it now as fallback (webhook may have failed)
    console.log('[verify-session] ========== FALLBACK ORDER CREATION ==========');
    console.log('[verify-session] Order not found for paymentIntentId:', paymentIntentId);
    console.log('[verify-session] Creating order as fallback...');
    console.log('[verify-session] Session metadata:', JSON.stringify(session.metadata, null, 2));

    // Get line items from Stripe session
    console.log('[verify-session] Fetching line items from Stripe...');
    const lineItemsResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      }
    );
    console.log('[verify-session] Line items response status:', lineItemsResponse.status);

    let items: any[] = [];

    // First try to get items from session metadata
    if (session.metadata?.items_json) {
      console.log('[verify-session] Parsing items from metadata...');
      try {
        items = JSON.parse(session.metadata.items_json);
        console.log('[verify-session] ✓ Parsed', items.length, 'items from metadata');
      } catch (e) {
        console.error('[verify-session] ❌ Error parsing items_json:', e);
      }
    } else {
      console.log('[verify-session] ⚠️ No items_json in metadata');
    }

    // Fallback to line items from Stripe
    if (items.length === 0 && lineItemsResponse.ok) {
      console.log('[verify-session] Using Stripe line items as fallback...');
      const lineItemsData = await lineItemsResponse.json();
      console.log('[verify-session] Raw line items count:', lineItemsData.data?.length || 0);
      items = (lineItemsData.data || [])
        .filter((item: any) => item.description !== 'Processing and platform fees' && item.description !== 'Service Fee')
        .map((item: any, index: number) => ({
          id: `stripe_item_${index}`,
          name: item.description || 'Item',
          price: (item.amount_total || item.price?.unit_amount || 0) / 100,
          quantity: item.quantity || 1,
          type: 'digital'
        }));
      console.log('[verify-session] ✓ Mapped', items.length, 'items from Stripe');
    }

    console.log('[verify-session] Final items count:', items.length);
    if (items.length > 0) {
      console.log('[verify-session] First item:', JSON.stringify(items[0]));
    } else {
      console.log('[verify-session] ⚠️ WARNING: No items for order!');
    }

    // Build shipping info if present
    let shipping = null;
    if (session.shipping_details?.address) {
      const addr = session.shipping_details.address;
      shipping = {
        address1: addr.line1 || '',
        address2: addr.line2 || '',
        city: addr.city || '',
        county: addr.state || '',
        postcode: addr.postal_code || '',
        country: addr.country || ''
      };
    }

    // Create the order
    const customerEmail = session.metadata?.customer_email || session.customer_email || session.customer_details?.email || 'unknown@email.com';
    console.log('[verify-session] Calling createOrder with:');
    console.log('[verify-session]   - Customer email:', customerEmail);
    console.log('[verify-session]   - Items count:', items.length);
    console.log('[verify-session]   - Total:', session.amount_total / 100);
    console.log('[verify-session]   - PaymentIntent:', session.payment_intent);
    console.log('[verify-session]   - env available:', !!env);

    const result = await createOrder({
      orderData: {
        customer: {
          email: session.metadata?.customer_email || session.customer_email || session.customer_details?.email || 'unknown@email.com',
          firstName: session.metadata?.customer_firstName || session.customer_details?.name?.split(' ')[0] || 'Customer',
          lastName: session.metadata?.customer_lastName || session.customer_details?.name?.split(' ').slice(1).join(' ') || '',
          phone: session.metadata?.customer_phone || session.customer_details?.phone || '',
          userId: session.metadata?.customer_userId || undefined
        },
        shipping,
        items,
        totals: {
          subtotal: parseFloat(session.metadata?.subtotal) || (session.amount_total / 100),
          shipping: parseFloat(session.metadata?.shipping) || 0,
          serviceFees: parseFloat(session.metadata?.serviceFees) || 0,
          total: session.amount_total / 100
        },
        hasPhysicalItems: session.metadata?.hasPhysicalItems === 'true',
        paymentMethod: 'stripe',
        paymentIntentId: session.payment_intent
      },
      env
    });

    console.log('[verify-session] createOrder returned:', JSON.stringify(result));

    if (result.success) {
      console.log('[verify-session] ✅ FALLBACK ORDER CREATED SUCCESSFULLY');
      console.log('[verify-session] Order Number:', result.orderNumber);
      console.log('[verify-session] Order ID:', result.orderId);
      console.log('[verify-session] ========== VERIFY SESSION COMPLETE ==========');
      return new Response(JSON.stringify({
        success: true,
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        paymentStatus: session.payment_status
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Order creation failed
    console.error('[verify-session] ❌ FALLBACK ORDER CREATION FAILED');
    console.error('[verify-session] Error:', result.error);
    console.log('[verify-session] ========== VERIFY SESSION COMPLETE (WITH ERROR) ==========');
    return new Response(JSON.stringify({
      success: true,
      orderId: null,
      paymentStatus: session.payment_status,
      message: 'Payment successful, order being processed',
      error: result.error
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[verify-session] ❌ EXCEPTION:', errorMessage);
    console.error('[verify-session] Stack:', error instanceof Error ? error.stack : 'no stack');
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
