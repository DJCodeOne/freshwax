// src/pages/api/stripe/create-checkout-session.ts
// Creates Stripe checkout session for product purchases

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientIdReq = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-checkout:${clientIdReq}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stripe not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const orderData = await request.json();
    console.log('[Stripe] Creating checkout session for:', orderData.customer?.email);

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

    // Build line items for Stripe
    const lineItems: string[][] = [];
    orderData.items.forEach((item: any, index: number) => {
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

    // Add service fees as a separate line item
    if (orderData.totals?.serviceFees > 0) {
      const feeIndex = orderData.items.length;
      lineItems.push(
        [`line_items[${feeIndex}][price_data][currency]`, 'gbp'],
        [`line_items[${feeIndex}][price_data][unit_amount]`, String(Math.round(orderData.totals.serviceFees * 100))],
        [`line_items[${feeIndex}][price_data][product_data][name]`, 'Service Fee'],
        [`line_items[${feeIndex}][price_data][product_data][description]`, 'Processing and platform fees'],
        [`line_items[${feeIndex}][quantity]`, '1']
      );
    }

    // Prepare metadata - store order data for webhook
    // Stripe metadata has 500 char limit per value, so we'll compress
    const metadata = {
      customer_email: orderData.customer.email,
      customer_firstName: orderData.customer.firstName,
      customer_lastName: orderData.customer.lastName,
      customer_phone: orderData.customer.phone || '',
      customer_userId: orderData.customer.userId || '',
      hasPhysicalItems: String(orderData.hasPhysicalItems),
      subtotal: String(orderData.totals.subtotal),
      shipping: String(orderData.totals.shipping),
      serviceFees: String(orderData.totals.serviceFees || 0),
      total: String(orderData.totals.total),
      // Items will be stored as compressed JSON
      items_count: String(orderData.items.length)
    };

    // Store items data (compressed)
    const itemsJson = JSON.stringify(orderData.items.map((item: any) => ({
      id: item.id,
      productId: item.productId,
      releaseId: item.releaseId,
      trackId: item.trackId,
      name: item.name,
      type: item.type,
      price: item.price,
      quantity: item.quantity,
      size: item.size,
      color: item.color
    })));

    // If items fit in metadata, store directly; otherwise we'll need session retrieval
    if (itemsJson.length <= 500) {
      (metadata as any).items_json = itemsJson;
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

    // Add shipping options if physical items
    if (orderData.hasPhysicalItems) {
      if (orderData.totals.shipping === 0) {
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
        bodyParams.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(Math.round(orderData.totals.shipping * 100)));
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

    // If items JSON was too large, store order data in custom session
    if (itemsJson.length > 500) {
      // We'll store the full order data reference and retrieve it in webhook
      // For now, we'll pass the order ID through idToken if available
      if (orderData.idToken) {
        bodyParams.append('metadata[has_idToken]', 'true');
      }
    }

    console.log('[Stripe] Creating checkout session...');

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
      return new Response(JSON.stringify({
        success: false,
        error: errorData.error?.message || 'Failed to create checkout session'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const session = await stripeResponse.json();
    console.log('[Stripe] Session created:', session.id);

    return new Response(JSON.stringify({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Stripe] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
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
