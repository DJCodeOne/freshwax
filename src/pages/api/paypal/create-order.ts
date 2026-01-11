// src/pages/api/paypal/create-order.ts
// Creates a PayPal order for checkout

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { addDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Validate item prices server-side to prevent manipulation
async function validateAndGetPrices(items: any[]): Promise<{ validatedItems: any[], hasPriceMismatch: boolean }> {
  const validatedItems: any[] = [];
  let hasPriceMismatch = false;

  for (const item of items) {
    let serverPrice = item.price;
    const itemType = item.type || 'digital';

    try {
      if (itemType === 'merch' && item.productId) {
        const product = await getDocument('merch', item.productId);
        if (product) {
          serverPrice = product.salePrice || product.retailPrice || product.price || item.price;
        }
      } else if (itemType === 'vinyl' || itemType === 'digital' || itemType === 'track' || itemType === 'release') {
        const releaseId = item.releaseId || item.productId || item.id;
        if (releaseId) {
          const release = await getDocument('releases', releaseId);
          if (release) {
            if (itemType === 'vinyl') {
              serverPrice = release.vinylPrice || release.price || item.price;
            } else if (itemType === 'track' && item.trackId) {
              const track = (release.tracks || []).find((t: any) =>
                t.id === item.trackId || t.trackId === item.trackId
              );
              serverPrice = track?.price || release.trackPrice || 0.99;
            } else {
              serverPrice = release.price || release.digitalPrice || item.price;
            }
          }
        }
      }

      if (Math.abs(serverPrice - item.price) > 0.02) {
        console.warn('[PayPal] Price mismatch for', item.name, '- Client:', item.price, 'Server:', serverPrice);
        hasPriceMismatch = true;
      }

      validatedItems.push({
        ...item,
        price: serverPrice,
        originalClientPrice: item.price
      });
    } catch (err) {
      console.error('[PayPal] Error validating price for', item.name, err);
      validatedItems.push({
        ...item,
        priceValidationFailed: true
      });
    }
  }

  return { validatedItems, hasPriceMismatch };
}

// Get PayPal API base URL based on mode
function getPayPalBaseUrl(mode: string): string {
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// Get PayPal access token
async function getPayPalAccessToken(clientId: string, clientSecret: string, mode: string): Promise<string> {
  const baseUrl = getPayPalBaseUrl(mode);
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[PayPal] Token error:', error);
    throw new Error('Failed to get PayPal access token');
  }

  const data = await response.json();
  return data.access_token;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-create:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;

    // Initialize Firebase for storing pending orders
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    // Get PayPal credentials
    const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
    const paypalSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
    const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';

    if (!paypalClientId || !paypalSecret) {
      console.error('[PayPal] Missing credentials');
      return new Response(JSON.stringify({
        success: false,
        error: 'PayPal not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const orderData = await request.json();
    console.log('[PayPal] Creating order for:', orderData.customer?.email);

    // Validate required fields
    if (!orderData.items || orderData.items.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No items in order'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SECURITY: Validate prices server-side to prevent manipulation
    console.log('[PayPal] Validating prices server-side...');
    const { validatedItems, hasPriceMismatch } = await validateAndGetPrices(orderData.items);

    if (hasPriceMismatch) {
      console.warn('[PayPal] SECURITY: Price manipulation detected');
      // Continue with server prices - don't reveal that we caught it
    }

    // Recalculate totals with validated prices
    const itemTotal = validatedItems.reduce((sum: number, item: any) =>
      sum + (item.price * (item.quantity || 1)), 0);
    const hasPhysicalItems = validatedItems.some((item: any) =>
      item.type === 'vinyl' || item.type === 'merch'
    );
    const shipping = hasPhysicalItems ? (itemTotal >= 50 ? 0 : 4.99) : 0;

    // Bandcamp-style: customer pays subtotal + shipping only
    // Fees are deducted from artist payout, not charged to customer
    const validatedTotal = itemTotal + shipping;

    // Calculate fees for payout purposes (deducted from artist share)
    const freshWaxFee = itemTotal * 0.01;
    const paymentProcessingFee = (validatedTotal * 0.014) + 0.20; // PayPal processing fee
    const serviceFees = freshWaxFee + paymentProcessingFee;

    console.log('[PayPal] Validated totals - Subtotal:', itemTotal, 'Total:', validatedTotal, '(fees deducted from payout:', serviceFees.toFixed(2), ')');

    // Get access token
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret, paypalMode);
    const baseUrl = getPayPalBaseUrl(paypalMode);

    // Build PayPal order items using VALIDATED prices
    const paypalItems = validatedItems.map((item: any) => ({
      name: item.name.substring(0, 127), // PayPal name limit
      unit_amount: {
        currency_code: 'GBP',
        value: item.price.toFixed(2) // This is now the validated server price
      },
      quantity: String(item.quantity || 1),
      category: item.type === 'merch' || item.type === 'vinyl' ? 'PHYSICAL_GOODS' : 'DIGITAL_GOODS'
    }));

    // Build PayPal order request using VALIDATED totals
    const paypalOrder: any = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'freshwax_order',
        description: 'Fresh Wax Order',
        custom_id: JSON.stringify({
          customer: orderData.customer,
          shipping: orderData.shipping,
          hasPhysicalItems: hasPhysicalItems,
          items: validatedItems.map((item: any) => ({
            id: item.id,
            productId: item.productId,
            releaseId: item.releaseId,
            trackId: item.trackId,
            name: item.name,
            type: item.type,
            price: item.price, // Validated server price
            quantity: item.quantity,
            size: item.size,
            color: item.color
          }))
        }).substring(0, 255), // PayPal custom_id limit - we'll store full data server-side
        amount: {
          currency_code: 'GBP',
          value: validatedTotal.toFixed(2), // Use validated total (no fees added)
          breakdown: {
            item_total: {
              currency_code: 'GBP',
              value: itemTotal.toFixed(2)
            },
            shipping: {
              currency_code: 'GBP',
              value: shipping.toFixed(2)
            }
          }
        },
        items: paypalItems
      }],
      application_context: {
        brand_name: 'Fresh Wax',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        return_url: 'https://freshwax.co.uk/checkout/success',
        cancel_url: 'https://freshwax.co.uk/checkout'
      }
    };

    // Add shipping address if physical items (using validated check)
    if (hasPhysicalItems && orderData.shipping) {
      paypalOrder.purchase_units[0].shipping = {
        name: {
          full_name: `${orderData.customer.firstName} ${orderData.customer.lastName}`
        },
        address: {
          address_line_1: orderData.shipping.address1,
          address_line_2: orderData.shipping.address2 || undefined,
          admin_area_2: orderData.shipping.city,
          admin_area_1: orderData.shipping.county || undefined,
          postal_code: orderData.shipping.postcode,
          country_code: getCountryCode(orderData.shipping.country)
        }
      };
    }

    console.log('[PayPal] Order request:', JSON.stringify(paypalOrder, null, 2).substring(0, 500));

    // Create PayPal order
    const createResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `freshwax_${Date.now()}_${Math.random().toString(36).substring(7)}`
      },
      body: JSON.stringify(paypalOrder)
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      console.error('[PayPal] Create order error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create PayPal order'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const paypalResult = await createResponse.json();
    console.log('[PayPal] Order created:', paypalResult.id);

    // Extract approval URL from PayPal response links
    const approvalLink = paypalResult.links?.find((link: any) => link.rel === 'approve');
    const approvalUrl = approvalLink?.href || null;

    // Store VALIDATED order data in Firebase for secure retrieval during capture
    // This prevents client-side tampering with order data
    try {
      const pendingOrder = {
        paypalOrderId: paypalResult.id,
        customer: orderData.customer,
        shipping: orderData.shipping || null,
        // Use VALIDATED items with server-verified prices
        items: validatedItems.map((item: any) => ({
          id: item.id,
          productId: item.productId,
          releaseId: item.releaseId,
          trackId: item.trackId,
          name: item.name,
          type: item.type,
          price: item.price, // This is now the validated server price
          quantity: item.quantity || 1,
          size: item.size,
          color: item.color,
          image: item.image,
          artwork: item.artwork,
          artist: item.artist,
          artistId: item.artistId // For Stripe Connect payouts
        })),
        // Use VALIDATED totals
        totals: {
          subtotal: itemTotal,
          shipping: shipping,
          freshWaxFee: freshWaxFee,
          paymentProcessingFee: paymentProcessingFee,
          serviceFees: serviceFees,
          total: validatedTotal,
          appliedCredit: orderData.appliedCredit || 0
        },
        hasPhysicalItems: hasPhysicalItems,
        appliedCredit: orderData.appliedCredit || 0,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hour expiry
      };

      await addDocument('pendingPayPalOrders', pendingOrder, paypalResult.id);
      console.log('[PayPal] Stored pending order data:', paypalResult.id);
    } catch (storeErr) {
      console.error('[PayPal] Failed to store pending order:', storeErr);
      // Continue anyway - capture endpoint will fall back to client data with amount validation
    }

    return new Response(JSON.stringify({
      success: true,
      orderId: paypalResult.id,
      status: paypalResult.status,
      approvalUrl: approvalUrl
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PayPal] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Convert country name to ISO country code
function getCountryCode(country: string): string {
  const countryMap: { [key: string]: string } = {
    'United Kingdom': 'GB',
    'UK': 'GB',
    'Ireland': 'IE',
    'Germany': 'DE',
    'France': 'FR',
    'Netherlands': 'NL',
    'Belgium': 'BE',
    'USA': 'US',
    'United States': 'US',
    'Canada': 'CA',
    'Australia': 'AU'
  };
  return countryMap[country] || 'GB';
}
