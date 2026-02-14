// src/pages/api/paypal/create-order.ts
// Creates a PayPal order for checkout

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { setDocument } from '../../../lib/firebase-rest';
import { validateStock, validateAndGetPrices, reserveStock, releaseReservation } from '../../../lib/order-utils';

export const prerender = false;

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
  let reservation: { success: boolean; reservationId?: string } | null = null;
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-create:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;

    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

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
    console.log('[PayPal] Creating order');

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

    // SECURITY: Validate stock availability before allowing checkout
    console.log('[PayPal] Validating stock availability...');
    const stockCheck = await validateStock(orderData.items);
    if (!stockCheck.available) {
      console.warn('[PayPal] Stock validation failed:', stockCheck.unavailableItems);
      return new Response(JSON.stringify({
        success: false,
        error: 'Some items are no longer available',
        unavailableItems: stockCheck.unavailableItems
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Reserve stock to prevent overselling
    reservation = await reserveStock(orderData.items, 'paypal_' + Date.now().toString(36), orderData.customer?.userId);
    if (!reservation.success) {
      return new Response(JSON.stringify({
        success: false,
        error: reservation.error || 'Failed to reserve stock'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // SECURITY: Validate prices server-side to prevent manipulation
    console.log('[PayPal] Validating prices server-side...');
    const { validatedItems, hasPriceMismatch, validationError } = await validateAndGetPrices(orderData.items, { logPrefix: '[PayPal]' });

    if (validationError) {
      if (reservation?.reservationId) await releaseReservation(reservation.reservationId).catch(() => {});
      return new Response(JSON.stringify({ success: false, error: validationError }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

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
    const hasMerchItems = validatedItems.some((item: any) => item.type === 'merch');
    const hasVinylItems = validatedItems.some((item: any) => item.type === 'vinyl');

    // Determine customer's shipping region
    const customerCountry = orderData.shipping?.country || 'GB';
    const isUK = customerCountry === 'GB' || customerCountry === 'United Kingdom' || customerCountry === 'UK';
    const isEU = ['DE', 'FR', 'NL', 'BE', 'IE', 'ES', 'IT', 'AT', 'PL', 'PT', 'DK', 'SE', 'FI', 'CZ', 'GR', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'CY', 'MT', 'LU'].includes(customerCountry);

    // Calculate shipping - merch and vinyl separately (matching Stripe flow)
    let merchShipping = 0;
    let vinylShippingTotal = 0;
    const artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> = {};

    // Merch shipping: only count merch items toward free shipping threshold
    if (hasMerchItems) {
      const merchSubtotal = validatedItems
        .filter((item: any) => item.type === 'merch')
        .reduce((sum: number, item: any) => sum + (item.price * (item.quantity || 1)), 0);
      merchShipping = merchSubtotal >= 50 ? 0 : 4.99;
    }

    // Vinyl shipping: per-artist rates based on customer region
    if (hasVinylItems) {
      for (const item of validatedItems) {
        if (item.type !== 'vinyl') continue;
        const artistId = item.artistId;
        if (!artistId) continue;

        // Determine rate based on customer region (using item data from price validation)
        let shippingRate = 0;
        if (item.isCratesItem) {
          // Vinyl crates: use seller's shipping cost
          shippingRate = item.cratesShippingCost || 4.99;
        } else if (isUK) {
          shippingRate = item.vinylShippingUK ?? item.artistVinylShippingUK ?? 4.99;
        } else if (isEU) {
          shippingRate = item.vinylShippingEU ?? item.artistVinylShippingEU ?? 9.99;
        } else {
          shippingRate = item.vinylShippingIntl ?? item.artistVinylShippingIntl ?? 14.99;
        }

        // Only charge shipping once per artist
        if (!artistShippingBreakdown[artistId]) {
          artistShippingBreakdown[artistId] = {
            artistId,
            artistName: item.artist || item.artistName || 'Artist',
            amount: shippingRate
          };
          vinylShippingTotal += shippingRate;
        }
      }
    }

    const shipping = merchShipping + vinylShippingTotal;

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
        return_url: 'https://freshwax.co.uk/api/paypal/capture-redirect',
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

    console.log('[PayPal] Order request created, items:', paypalItems.length);

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
      if (reservation?.reservationId) await releaseReservation(reservation.reservationId).catch(() => {});
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
          appliedCredit: 0
        },
        hasPhysicalItems: hasPhysicalItems,
        artistShippingBreakdown: Object.keys(artistShippingBreakdown).length > 0 ? artistShippingBreakdown : null,
        appliedCredit: 0,
        reservationId: reservation.reservationId || null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hour expiry
      };

      await setDocument('pendingPayPalOrders', paypalResult.id, pendingOrder);
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
    if (reservation?.reservationId) await releaseReservation(reservation.reservationId).catch(() => {});
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred'
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
