// src/pages/api/stripe/create-checkout-session.ts
// Creates Stripe checkout session for product purchases

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { addDocument } from '../../../lib/firebase-rest';
import { validateStock, validateAndGetPrices, reserveStock, releaseReservation } from '../../../lib/order-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-checkout:${clientIdReq}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  let reservation: { success: boolean; reservationId?: string } | null = null;
  try {
    const env = locals.runtime.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stripe not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const orderData = await request.json();

    // Validate required fields
    if (!orderData.items || orderData.items.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No items in order'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!orderData.customer?.email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Customer email required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // SECURITY: Validate stock availability before allowing checkout
    const stockCheck = await validateStock(orderData.items);
    if (!stockCheck.available) {
      console.warn('[Stripe] Stock validation failed:', stockCheck.unavailableItems);
      return new Response(JSON.stringify({
        success: false,
        error: 'Some items are no longer available',
        unavailableItems: stockCheck.unavailableItems
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Reserve stock to prevent overselling
    reservation = await reserveStock(orderData.items, 'stripe_' + Date.now().toString(36), orderData.customer?.userId);
    if (!reservation.success) {
      return new Response(JSON.stringify({
        success: false,
        error: reservation.error || 'Failed to reserve stock'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // SECURITY: Validate prices server-side to prevent manipulation
    const { validatedItems, hasPriceMismatch, validationError } = await validateAndGetPrices(orderData.items, { logPrefix: '[Stripe]' });

    if (validationError) {
      if (reservation.reservationId) await releaseReservation(reservation.reservationId).catch(() => {});
      return new Response(JSON.stringify({ success: false, error: validationError }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (hasPriceMismatch) {
      console.warn('[Stripe] SECURITY: Price manipulation detected');
      // Continue with server prices - don't reveal that we caught it
    }

    // Recalculate totals with validated prices
    const validatedSubtotal = validatedItems.reduce((sum: number, item: any) =>
      sum + (item.price * (item.quantity || 1)), 0);
    const hasPhysicalItems = validatedItems.some((item: any) =>
      item.type === 'vinyl' || item.type === 'merch'
    );
    const hasMerchItems = validatedItems.some((item: any) => item.type === 'merch');
    const hasVinylItems = validatedItems.some((item: any) => item.type === 'vinyl');

    // Determine customer's shipping region from their country
    const customerCountry = orderData.shipping?.country || 'GB';
    const isUK = customerCountry === 'GB' || customerCountry === 'United Kingdom' || customerCountry === 'UK';
    const isEU = ['DE', 'FR', 'NL', 'BE', 'IE', 'ES', 'IT', 'AT', 'PL', 'PT', 'DK', 'SE', 'FI', 'CZ', 'GR', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'CY', 'MT', 'LU'].includes(customerCountry);

    // Calculate shipping - vinyl shipping goes to artists, merch shipping stays with platform
    let merchShipping = 0;
    let vinylShippingTotal = 0;
    const artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> = {};

    // Merch shipping (platform default £4.99, free over £50 merch subtotal)
    if (hasMerchItems) {
      const merchSubtotal = validatedItems
        .filter((item: any) => item.type === 'merch')
        .reduce((sum: number, item: any) => sum + (item.price * (item.quantity || 1)), 0);
      merchShipping = merchSubtotal >= 50 ? 0 : 4.99;
    }

    // Vinyl shipping (per-artist, based on release or artist defaults)
    if (hasVinylItems) {
      for (const item of validatedItems) {
        if (item.type !== 'vinyl') continue;

        const releaseId = item.releaseId || item.productId || item.id;
        const artistId = item.artistId;

        if (!artistId || !releaseId) continue;

        // Get shipping rate for this item (already fetched during price validation)
        // Determine rate based on customer region
        let shippingRate = 0;
        if (isUK) {
          shippingRate = item.vinylShippingUK ?? item.artistVinylShippingUK ?? 4.99;
        } else if (isEU) {
          shippingRate = item.vinylShippingEU ?? item.artistVinylShippingEU ?? 9.99;
        } else {
          shippingRate = item.vinylShippingIntl ?? item.artistVinylShippingIntl ?? 14.99;
        }

        // Only charge shipping once per artist (not per item)
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

    const validatedShipping = merchShipping + vinylShippingTotal;

    // Bandcamp-style: customer pays subtotal + shipping only
    // Fees are deducted from artist payout, not charged to customer
    const validatedTotal = validatedSubtotal + validatedShipping;

    // Calculate fees for payout purposes (deducted from artist share)
    const freshWaxFee = validatedSubtotal * 0.01;
    const stripeFee = (validatedTotal * 0.014) + 0.20;
    const validatedServiceFees = freshWaxFee + stripeFee;

    // Build line items for Stripe using VALIDATED prices
    const lineItems: string[][] = [];
    validatedItems.forEach((item: any, index: number) => {
      lineItems.push(
        [`line_items[${index}][price_data][currency]`, 'gbp'],
        [`line_items[${index}][price_data][unit_amount]`, String(Math.round(item.price * 100))], // Stripe uses cents
        [`line_items[${index}][price_data][product_data][name]`, item.name.substring(0, 500)],
        [`line_items[${index}][price_data][product_data][description]`, getItemDescription(item)],
        [`line_items[${index}][quantity]`, String(item.quantity || 1)]
      );

      // Add image if available
      if (item.image || item.artwork) {
        lineItems.push([`line_items[${index}][price_data][product_data][images][0]`, item.image || item.artwork]);
      }
    });

    // Note: Service fees are NOT added as line items anymore (Bandcamp-style)
    // Fees are deducted from artist payout instead of being charged to customer

    // Credit is only applied via the free order flow (complete-free-order.ts)
    // which validates prices and credit balance server-side.
    // Stripe sessions always charge the full validated amount.
    const appliedCredit = 0;

    // Prepare metadata - store order data for webhook
    // Stripe metadata has 500 char limit per value, so we'll compress
    // IMPORTANT: Use validated values, not client-submitted values
    const metadata = {
      customer_email: orderData.customer.email,
      customer_firstName: orderData.customer.firstName,
      customer_lastName: orderData.customer.lastName,
      customer_displayName: orderData.customer.displayName || orderData.customer.firstName || '',
      customer_phone: orderData.customer.phone || '',
      customer_userId: orderData.customer.userId || '',
      hasPhysicalItems: String(hasPhysicalItems),
      subtotal: String(validatedSubtotal),
      shipping: String(validatedShipping),
      serviceFees: String(validatedServiceFees),
      total: String(validatedTotal),
      appliedCredit: String(appliedCredit),
      // Items will be stored as compressed JSON
      items_count: String(validatedItems.length),
      ...(reservation.reservationId ? { reservation_id: reservation.reservationId } : {})
    };

    // Store items data (compressed) - using VALIDATED prices
    const compressedItems = validatedItems.map((item: any) => ({
      id: item.id,
      productId: item.productId,
      releaseId: item.releaseId,
      trackId: item.trackId,
      name: item.name,
      type: item.type,
      price: item.price, // This is now the validated server price
      quantity: item.quantity,
      size: item.size,
      color: item.color,
      image: item.image,
      artwork: item.artwork,
      artist: item.artist,
      artistId: item.artistId, // For Stripe Connect payouts
      title: item.title
    }));
    const itemsJson = JSON.stringify(compressedItems);

    // If items fit in metadata, store directly; otherwise store in Firestore
    if (itemsJson.length <= 500) {
      (metadata as any).items_json = itemsJson;
    } else {
      // Items too large for metadata - store in Firestore pendingCheckouts collection
      console.debug('[Stripe] Items JSON too large (' + itemsJson.length + ' chars), storing in Firestore');

      // Firebase already initialized above for price validation

      try {
        // Store VALIDATED data in pending checkout
        const pendingCheckout = {
          items: compressedItems, // Using validated items with server prices
          customer: orderData.customer,
          shipping: orderData.shipping || null,
          totals: {
            subtotal: validatedSubtotal,
            shipping: validatedShipping,
            merchShipping: merchShipping,
            vinylShipping: vinylShippingTotal,
            freshWaxFee: freshWaxFee,
            stripeFee: stripeFee,
            serviceFees: validatedServiceFees,
            total: validatedTotal,
            appliedCredit: appliedCredit
          },
          hasPhysicalItems: hasPhysicalItems,
          hasMerchItems: hasMerchItems,
          hasVinylItems: hasVinylItems,
          appliedCredit: appliedCredit,
          artistShippingBreakdown: Object.keys(artistShippingBreakdown).length > 0 ? artistShippingBreakdown : null,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hour expiry
        };

        const docRef = await addDocument('pendingCheckouts', pendingCheckout);
        (metadata as any).pending_checkout_id = docRef.id;
        console.debug('[Stripe] Stored pending checkout:', docRef.id);
      } catch (pendingErr) {
        console.error('[Stripe] Failed to store pending checkout:', pendingErr);
        // Continue anyway - webhook can fall back to line items
      }
    }

    // Build request body
    const bodyParams = new URLSearchParams();
    bodyParams.append('mode', 'payment');
    bodyParams.append('payment_method_types[0]', 'card'); // Only allow card payments
    bodyParams.append('success_url', `${new URL(request.url).origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
    bodyParams.append('cancel_url', `${new URL(request.url).origin}/checkout`);

    // Add line items
    lineItems.forEach(([key, value]) => {
      bodyParams.append(key, value);
    });

    // Add metadata
    Object.entries(metadata).forEach(([key, value]) => {
      bodyParams.append(`metadata[${key}]`, value as string);
    });

    // Add shipping options if physical items (using validated values)
    if (hasPhysicalItems) {
      if (validatedShipping === 0) {
        bodyParams.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
        bodyParams.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', '0');
        bodyParams.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'gbp');
        bodyParams.append('shipping_options[0][shipping_rate_data][display_name]', 'Free Shipping');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]', '3');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]', '7');
      } else {
        bodyParams.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
        bodyParams.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(Math.round(validatedShipping * 100)));
        bodyParams.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'gbp');
        bodyParams.append('shipping_options[0][shipping_rate_data][display_name]', 'Standard Shipping');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]', '3');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');
        bodyParams.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]', '7');
      }

      // Enable shipping address collection
      bodyParams.append('shipping_address_collection[allowed_countries][0]', 'GB');
      bodyParams.append('shipping_address_collection[allowed_countries][1]', 'IE');
      bodyParams.append('shipping_address_collection[allowed_countries][2]', 'DE');
      bodyParams.append('shipping_address_collection[allowed_countries][3]', 'FR');
      bodyParams.append('shipping_address_collection[allowed_countries][4]', 'NL');
      bodyParams.append('shipping_address_collection[allowed_countries][5]', 'BE');
      bodyParams.append('shipping_address_collection[allowed_countries][6]', 'US');
      bodyParams.append('shipping_address_collection[allowed_countries][7]', 'CA');
      bodyParams.append('shipping_address_collection[allowed_countries][8]', 'AU');
    }

    // Create Stripe checkout session
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyParams.toString()
    });

    if (!stripeResponse.ok) {
      const errorData = await stripeResponse.json();
      console.error('[Stripe] Create session error:', errorData);
      if (reservation.reservationId) await releaseReservation(reservation.reservationId).catch(() => {});
      return new Response(JSON.stringify({
        success: false,
        error: errorData.error?.message || 'Failed to create checkout session'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const session = await stripeResponse.json();

    return new Response(JSON.stringify({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Stripe] Error:', errorMessage);
    // Release any reservation made before the error
    if (reservation?.reservationId) await releaseReservation(reservation.reservationId).catch(() => {});
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

function getItemDescription(item: any): string {
  const parts = [];
  if (item.type) parts.push(formatType(item.type));
  if (item.size) parts.push(`Size: ${item.size}`);
  if (item.color) parts.push(item.color);
  if (item.artist) parts.push(`by ${item.artist}`);
  return parts.join(' • ') || 'Fresh Wax Item';
}

function formatType(type: string): string {
  const typeMap: { [key: string]: string } = {
    'digital': 'Digital Download',
    'track': 'Single Track',
    'release': 'Digital Release',
    'vinyl': 'Vinyl Record',
    'merch': 'Merchandise'
  };
  return typeMap[type] || type;
}
