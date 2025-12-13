// src/pages/api/create-order.ts
// Creates order in Firebase and sends confirmation email

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, addDocument, incrementField, initFirebaseEnv } from '../../lib/firebase-rest';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Generate order number
function generateOrderNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FW-${year}${month}${day}-${random}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const orderData = await request.json();

    log.info('[create-order] Processing order:', orderData.customer?.email);

    // Validate required fields
    if (!orderData.customer?.email || !orderData.customer?.firstName || !orderData.customer?.lastName) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required customer information'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!orderData.items || orderData.items.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No items in order'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check shipping for physical items
    if (orderData.hasPhysicalItems && !orderData.shipping?.address1) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Shipping address required for physical items'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // IMPORTANT: Verify user is a customer (only customers can purchase)
    if (orderData.customer.userId) {
      const [customerDoc, userDoc, artistDoc] = await Promise.all([
        getDocument('customers', orderData.customer.userId),
        getDocument('users', orderData.customer.userId),
        getDocument('artists', orderData.customer.userId)
      ]);

      const isCustomer = !!customerDoc || !!userDoc;
      const isArtist = !!artistDoc;

      // If user is an artist but NOT a customer, deny the order
      if (isArtist && !isCustomer) {
        log.info('[create-order] ✗ Denied: Artist account attempting to purchase');
        return new Response(JSON.stringify({
          success: false,
          error: 'Artist accounts cannot make purchases. Please create a separate customer account to buy items.'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // Log warning if no customer record found but still allow guest checkout
      if (!isCustomer) {
        log.info('[create-order] ⚠️ No customer record found for userId:', orderData.customer.userId);
      } else {
        log.info('[create-order] ✓ Customer verified:', orderData.customer.userId);
      }
    } else {
      // Guest checkout - allowed for non-logged-in users
      log.info('[create-order] Guest checkout for:', orderData.customer.email);
    }

    const orderNumber = generateOrderNumber();
    const now = new Date().toISOString();

    // Get download URLs for digital items
    const itemsWithDownloads = await Promise.all(orderData.items.map(async (item: any) => {
      // Get the release ID (could be stored as id, productId, or releaseId)
      const releaseId = item.releaseId || item.productId || item.id;

      log.info('[create-order] Processing item:', item.name, 'type:', item.type, 'releaseId:', releaseId);

      // Check if this is a digital release, track, or vinyl
      if (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.type === 'vinyl' || (!item.type && releaseId)) {
        try {
          // Try to fetch release data for download URLs
          log.info('[create-order] Fetching release from Firebase:', releaseId);
          const releaseData = await getDocument('releases', releaseId);

          if (releaseData) {
            log.info('[create-order] Release found:', releaseData?.releaseName);
            log.info('[create-order] Tracks count:', releaseData?.tracks?.length || 0);
            log.info('[create-order] Artwork fields - coverArtUrl:', releaseData?.coverArtUrl, 'artwork.cover:', releaseData?.artwork?.cover, 'artwork.artworkUrl:', releaseData?.artwork?.artworkUrl);
            log.info('[create-order] Item artwork from cart:', item.artwork, 'Item image from cart:', item.image);

            // If it's a single track purchase, only include that track
            if (item.type === 'track') {
              let track = null;

              // Method 1: Match by trackId
              if (item.trackId) {
                track = (releaseData?.tracks || []).find((t: any) =>
                  t.id === item.trackId ||
                  t.trackId === item.trackId ||
                  String(t.trackNumber) === String(item.trackId)
                );
              }

              // Method 2: Match by track name from item name
              if (!track && item.name) {
                const itemNameParts = item.name.split(' - ');
                const trackNameFromItem = itemNameParts.length > 1 ? itemNameParts.slice(1).join(' - ') : item.name;
                track = (releaseData?.tracks || []).find((t: any) =>
                  (t.trackName || t.name || '').toLowerCase() === trackNameFromItem.toLowerCase()
                );
              }

              // Method 3: Match by title field
              if (!track && item.title) {
                track = (releaseData?.tracks || []).find((t: any) =>
                  (t.trackName || t.name || '').toLowerCase() === item.title.toLowerCase()
                );
              }

              log.info('[create-order] Single track found:', track?.trackName || 'NOT FOUND');

              // Get artist and release name for filename
              const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
              const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';

              if (track) {
                // Get artwork from Firebase - check all possible locations
                const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;
                log.info('[create-order] Track artwork URL:', artworkUrl);
                return {
                  ...item,
                  releaseId,
                  artwork: artworkUrl,
                  image: artworkUrl,
                  downloads: {
                    artistName,
                    releaseName,
                    artworkUrl,
                    tracks: [{
                      name: track.trackName || track.name || item.title,
                      mp3Url: track.mp3Url || null,
                      wavUrl: track.wavUrl || null
                    }]
                  }
                };
              } else {
                // Fallback: include all tracks if we can't find the specific one
                const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;
                log.info('[create-order] Fallback artwork URL:', artworkUrl);
                return {
                  ...item,
                  releaseId,
                  artwork: artworkUrl,
                  image: artworkUrl,
                  downloads: {
                    artistName,
                    releaseName,
                    artworkUrl,
                    tracks: (releaseData?.tracks || []).map((t: any) => ({
                      name: t.trackName || t.name,
                      mp3Url: t.mp3Url || null,
                      wavUrl: t.wavUrl || null
                    }))
                  }
                };
              }
            }

            // Full release - include all tracks
            const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
            const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';
            // Get artwork from Firebase - check all possible locations (coverArtUrl is at root level)
            const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;
            log.info('[create-order] Full release artwork URL:', artworkUrl);

            const downloads = {
              artistName,
              releaseName,
              artworkUrl,
              tracks: (releaseData?.tracks || []).map((track: any) => ({
                name: track.trackName || track.name,
                mp3Url: track.mp3Url || null,
                wavUrl: track.wavUrl || null
              }))
            };
            log.info('[create-order] Downloads prepared:', downloads.tracks.length, 'tracks, artworkUrl:', artworkUrl ? 'YES' : 'NO');

            return {
              ...item,
              releaseId,
              artwork: artworkUrl,
              image: artworkUrl,
              downloads
            };
          } else {
            log.info('[create-order] Release NOT found:', releaseId);
          }
        } catch (e) {
          console.error('[create-order] Error fetching release:', releaseId, e);
        }
      } else {
        log.info('[create-order] Skipping non-digital item:', item.type);
      }
      return { ...item, releaseId };
    }));

    // Create order document
    // Check if any items are pre-orders
    const hasPreOrderItems = itemsWithDownloads.some((item: any) => item.isPreOrder === true);
    const preOrderReleaseDates = itemsWithDownloads
      .filter((item: any) => item.isPreOrder && item.releaseDate)
      .map((item: any) => new Date(item.releaseDate));
    const latestPreOrderDate = preOrderReleaseDates.length > 0
      ? new Date(Math.max(...preOrderReleaseDates.map((d: Date) => d.getTime()))).toISOString()
      : null;

    const order = {
      orderNumber,
      customer: {
        email: orderData.customer.email,
        firstName: orderData.customer.firstName,
        lastName: orderData.customer.lastName,
        phone: orderData.customer.phone || '',
        userId: orderData.customer.userId || null
      },
      customerId: orderData.customer.userId || null,  // Top-level for easy querying
      shipping: orderData.shipping || null,
      items: itemsWithDownloads,
      totals: {
        subtotal: orderData.totals.subtotal,
        shipping: orderData.totals.shipping,
        total: orderData.totals.total
      },
      hasPhysicalItems: orderData.hasPhysicalItems,
      hasPreOrderItems,
      preOrderDeliveryDate: latestPreOrderDate,
      paymentMethod: orderData.paymentMethod || 'test_mode',
      paymentStatus: 'completed',
      orderStatus: hasPreOrderItems ? 'awaiting_release' : (orderData.hasPhysicalItems ? 'processing' : 'completed'),
      createdAt: now,
      updatedAt: now
    };

    // Save to Firebase
    const orderRef = await addDocument('orders', order);

    log.info('[create-order] ✓ Order created:', orderNumber, orderRef.id);

    // Update stock for merch items
    for (const item of order.items) {
      if (item.type === 'merch' && item.productId) {
        try {
          log.info('[create-order] Updating stock for merch item:', item.name, 'qty:', item.quantity);

          // Get the product to find variant key
          const productData = await getDocument('merch', item.productId);

          if (productData) {
            const variantStock = productData.variantStock || {};

            // Build variant key from size and color
            const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
            const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
            let variantKey = size + '_' + color;

            // Check if variant exists, otherwise try default
            if (!variantStock[variantKey]) {
              // Try to find matching variant
              const keys = Object.keys(variantStock);
              if (keys.length === 1) {
                variantKey = keys[0];
              } else {
                // Try matching by size only
                const sizeMatch = keys.find(k => k.startsWith(size + '_'));
                if (sizeMatch) variantKey = sizeMatch;
              }
            }

            const variant = variantStock[variantKey];

            if (variant) {
              const previousStock = variant.stock || 0;
              const newStock = Math.max(0, previousStock - item.quantity);

              variant.stock = newStock;
              variant.sold = (variant.sold || 0) + item.quantity;
              variantStock[variantKey] = variant;

              // Calculate totals
              let totalStock = 0;
              let totalSold = 0;
              Object.values(variantStock).forEach((v: any) => {
                totalStock += v.stock || 0;
                totalSold += v.sold || 0;
              });

              // Update product
              await updateDocument('merch', item.productId, {
                variantStock: variantStock,
                totalStock: totalStock,
                soldStock: totalSold,
                isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                isOutOfStock: totalStock === 0,
                updatedAt: now
              });

              // Record stock movement
              await addDocument('merch-stock-movements', {
                productId: item.productId,
                productName: item.name,
                sku: productData.sku,
                variantKey: variantKey,
                variantSku: variant.sku,
                type: 'sell',
                quantity: item.quantity,
                stockDelta: -item.quantity,
                previousStock: previousStock,
                newStock: newStock,
                orderId: orderRef.id,
                orderNumber: orderNumber,
                notes: 'Order ' + orderNumber,
                createdAt: now,
                createdBy: 'system'
              });

              log.info('[create-order] ✓ Stock updated:', item.name, variantKey, previousStock, '->', newStock);

              // Update supplier stats if applicable
              if (productData.supplierId) {
                try {
                  const supplierRevenue = (productData.retailPrice || item.price) * item.quantity * ((productData.supplierCut || 0) / 100);

                  // Fetch current supplier data
                  const supplierData = await getDocument('merch-suppliers', productData.supplierId);
                  if (supplierData) {
                    await updateDocument('merch-suppliers', productData.supplierId, {
                      totalStock: (supplierData.totalStock || 0) - item.quantity,
                      totalSold: (supplierData.totalSold || 0) + item.quantity,
                      totalRevenue: (supplierData.totalRevenue || 0) + supplierRevenue,
                      updatedAt: now
                    });
                    log.info('[create-order] ✓ Supplier stats updated');
                  }
                } catch (supplierErr) {
                  log.info('[create-order] Could not update supplier stats');
                }
              }
            } else {
              log.info('[create-order] ⚠️ Variant not found:', variantKey, 'for product:', item.productId);
            }
          } else {
            log.info('[create-order] ⚠️ Product not found for stock update:', item.productId);
          }
        } catch (stockErr) {
          // Log but don't fail the order
          console.error('[create-order] Stock update error:', stockErr);
        }
      }
    }

    // Log item artwork data for debugging
    for (const item of order.items) {
      log.info('[create-order] Item for email:', item.name, '| artwork:', item.artwork, '| image:', item.image, '| downloads.artworkUrl:', item.downloads?.artworkUrl);
    }

    // Send confirmation email directly
    try {
      const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;

      if (RESEND_API_KEY && order.customer?.email) {
        log.info('[create-order] Sending email to:', order.customer.email);

        // Extract short order number for customer display (e.g., "FW-ABC123" from "FW-241204-abc123")
        const orderParts = orderNumber.split('-');
        const shortOrderNumber = orderParts.length >= 3
          ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
          : orderNumber.toUpperCase();

        const emailHtml = buildOrderConfirmationEmail(orderRef.id, shortOrderNumber, order);

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <orders@freshwax.co.uk>',
            to: [order.customer.email],
            subject: 'Order Confirmed - ' + shortOrderNumber,
            html: emailHtml
          })
        });

        if (emailResponse.ok) {
          const emailResult = await emailResponse.json();
          log.info('[create-order] ✓ Email sent! ID:', emailResult.id);
        } else {
          const error = await emailResponse.text();
          console.error('[create-order] ❌ Email failed:', error);
        }
      } else {
        log.info('[create-order] Skipping email - no API key or no customer email');
      }
    } catch (emailError) {
      console.error('[create-order] Email error:', emailError);
      // Don't fail the order if email fails
    }

    // Send fulfillment email to stockist/label for vinyl orders
    const vinylItems = order.items.filter((item: any) => item.type === 'vinyl');
    if (vinylItems.length > 0) {
      try {
        const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
        const STOCKIST_EMAIL = import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

        if (RESEND_API_KEY && STOCKIST_EMAIL) {
          log.info('[create-order] Sending vinyl fulfillment email to stockist:', STOCKIST_EMAIL);

          const fulfillmentHtml = buildStockistFulfillmentEmail(orderRef.id, orderNumber, order, vinylItems);

          const fulfillmentResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
              to: [STOCKIST_EMAIL],
              subject: '📦 VINYL FULFILLMENT REQUIRED - ' + orderNumber,
              html: fulfillmentHtml
            })
          });

          if (fulfillmentResponse.ok) {
            const result = await fulfillmentResponse.json();
            log.info('[create-order] ✓ Stockist email sent! ID:', result.id);
          } else {
            const error = await fulfillmentResponse.text();
            console.error('[create-order] ❌ Stockist email failed:', error);
          }
        }
      } catch (stockistError) {
        console.error('[create-order] Stockist email error:', stockistError);
        // Don't fail the order if stockist email fails
      }
    }

    // Update customer's order count if they have an account
    if (orderData.customer.userId) {
      try {
        const customerDoc = await getDocument('customers', orderData.customer.userId);
        if (customerDoc) {
          await updateDocument('customers', orderData.customer.userId, {
            orderCount: (customerDoc.orderCount || 0) + 1,
            lastOrderAt: now
          });
        }
      } catch (e) {
        console.error('[create-order] Error updating customer:', e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      orderId: orderRef.id,
      orderNumber
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[create-order] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to create order',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Email template function - Light theme
function buildOrderConfirmationEmail(orderId: string, orderNumber: string, order: any): string {
  const confirmationUrl = 'https://freshwax.co.uk/order-confirmation/' + orderId;

  // Build items HTML - only show image for merch items
  let itemsHtml = '';
  for (const item of order.items) {
    // Check if this is a merch item (only merch gets images)
    const isMerchItem = item.type === 'merch';

    // Only use image for merch
    const itemImage = isMerchItem ? (item.image || item.artwork || '') : '';

    // Format the item type for display
    let typeLabel = '';
    if (item.type === 'digital') typeLabel = 'Digital Download';
    else if (item.type === 'track') typeLabel = 'Single Track';
    else if (item.type === 'vinyl') typeLabel = 'Vinyl Record';
    else if (item.type === 'merch') typeLabel = 'Merchandise';
    else typeLabel = item.type || '';

    // Only show image column for merch - centered
    const imageHtml = itemImage ? '<img src="' + itemImage + '" alt="' + item.name + '" width="70" height="70" style="border-radius: 8px; display: block; margin: 0 auto;">' : '';

    itemsHtml += '<tr><td style="padding: 16px 0; border-bottom: 1px solid #e5e7eb;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      (itemImage ? '<td width="86" style="padding-right: 16px; vertical-align: middle; text-align: center;">' + imageHtml + '</td>' : '') +
      '<td style="vertical-align: middle; text-align: left;">' +
      '<div style="font-weight: 600; color: #111; font-size: 15px; margin-bottom: 4px; text-align: left;">' + item.name + '</div>' +
      '<div style="font-size: 13px; color: #6b7280; text-align: left;">' +
      typeLabel +
      (item.size ? ' • Size: ' + item.size : '') +
      (item.color ? ' • ' + item.color : '') +
      (item.quantity > 1 ? ' • Qty: ' + item.quantity : '') +
      '</div></td>' +
      '<td width="80" style="text-align: right; font-weight: 600; color: #111; vertical-align: middle;">£' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr></table></td></tr>';
  }

  // Shipping section
  const shippingSection = order.shipping ?
    '<tr><td style="padding: 20px 24px; background: #f9fafb; border-radius: 8px; margin-top: 16px;">' +
    '<div style="font-weight: 700; color: #111; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Shipping To</div>' +
    '<div style="color: #374151; line-height: 1.6; font-size: 14px;">' +
    order.customer.firstName + ' ' + order.customer.lastName + '<br>' +
    order.shipping.address1 + '<br>' +
    (order.shipping.address2 ? order.shipping.address2 + '<br>' : '') +
    order.shipping.city + ', ' + order.shipping.postcode + '<br>' +
    (order.shipping.county ? order.shipping.county + '<br>' : '') +
    order.shipping.country +
    '</div></td></tr><tr><td style="height: 16px;"></td></tr>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Order Confirmation</title></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header with logo and brand - BLACK background
    '<tr><td style="background: #000000; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #9ca3af; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +

    // Main content card
    '<tr><td style="background: #ffffff; padding: 32px 24px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="width: 56px; height: 56px; background: #dcfce7; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">' +
    '<span style="color: #16a34a; font-size: 28px;">✓</span></div>' +
    '<h1 style="margin: 0; color: #111; font-size: 24px; font-weight: 700;">Order Confirmed!</h1>' +
    '<p style="margin: 8px 0 0; color: #6b7280; font-size: 14px;">Thank you for your purchase</p>' +
    '</td></tr>' +

    // Order number
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="display: inline-block; background: #f3f4f6; padding: 12px 24px; border-radius: 8px;">' +
    '<div style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>' +
    '<div style="color: #dc2626; font-size: 18px; font-weight: 700; margin-top: 4px;">' + orderNumber + '</div>' +
    '</div></td></tr>' +

    // Divider
    '<tr><td style="border-top: 1px solid #e5e7eb; padding-top: 24px;"></td></tr>' +

    // Items header - green with dividing line
    '<tr><td style="padding-bottom: 12px; border-bottom: 1px solid #e5e7eb;">' +
    '<div style="font-weight: 700; color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Order Details</div>' +
    '</td></tr>' +

    // Items list
    '<tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%">' + itemsHtml + '</table></td></tr>' +

    // Totals - red dividing line above
    '<tr><td style="padding-top: 16px; border-top: 2px solid #dc2626;"><table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Subtotal</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">£' + order.totals.subtotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Shipping</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">' +
    (order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : '£' + order.totals.shipping.toFixed(2)) : 'Digital delivery') + '</td></tr>' +
    '<tr><td colspan="2" style="border-top: 2px solid #dc2626; padding-top: 12px;"></td></tr>' +
    '<tr><td style="color: #111; font-weight: 700; font-size: 16px; padding: 4px 0;">Total</td>' +
    '<td style="color: #dc2626; font-weight: 700; font-size: 20px; text-align: right; padding: 4px 0;">£' + order.totals.total.toFixed(2) + '</td></tr>' +
    '</table></td></tr>' +

    // Spacing
    '<tr><td style="height: 24px;"></td></tr>' +

    // Shipping address (if applicable)
    shippingSection +

    // Go back to store button
    '<tr><td align="center" style="padding: 24px 0 8px;">' +
    '<a href="https://freshwax.co.uk" style="display: inline-block; padding: 14px 32px; background: #000000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Go Back to Store</a>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px; line-height: 1.6;">Question? Email us at <a href="mailto:contact@freshwax.co.uk" style="color: #111; text-decoration: underline;">contact@freshwax.co.uk</a></div>' +
    '<div style="margin-top: 12px;"><a href="https://freshwax.co.uk" style="color: #9ca3af; font-size: 12px; text-decoration: none;">freshwax.co.uk</a></div>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// Stockist/Label fulfillment email - sent when vinyl is ordered
function buildStockistFulfillmentEmail(orderId: string, orderNumber: string, order: any, vinylItems: any[]): string {
  const orderDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Build vinyl items table
  let itemsHtml = '';
  for (const item of vinylItems) {
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">' + item.name + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">£' + (item.price * (item.quantity || 1)).toFixed(2) + '</td>' +
      '</tr>';
  }

  // Calculate vinyl total
  const vinylTotal = vinylItems.reduce((sum: number, item: any) => sum + (item.price * (item.quantity || 1)), 0);

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header - urgent red
    '<tr><td style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 1px;">📦 VINYL FULFILLMENT REQUIRED</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 8px;">Fresh Wax Order</div>' +
    '</td></tr>' +

    // Main content
    '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Order info box
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Details</div>' +
    '<div style="font-size: 24px; font-weight: 800; color: #000; margin-bottom: 4px;">' + orderNumber + '</div>' +
    '<div style="font-size: 14px; color: #666;">' + orderDate + '</div>' +
    '</td></tr></table>' +
    '</td></tr>' +

    // Shipping address - IMPORTANT
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #dc2626; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #dc2626; padding-bottom: 8px;">📍 Ship To</div>' +
    '<div style="font-size: 16px; line-height: 1.6; color: #111;">' +
    '<strong>' + order.customer.firstName + ' ' + order.customer.lastName + '</strong><br>' +
    (order.shipping?.address1 || '') + '<br>' +
    (order.shipping?.address2 ? order.shipping.address2 + '<br>' : '') +
    (order.shipping?.city || '') + '<br>' +
    (order.shipping?.postcode || '') + '<br>' +
    (order.shipping?.county ? order.shipping.county + '<br>' : '') +
    (order.shipping?.country || 'United Kingdom') +
    '</div>' +
    (order.customer.phone ? '<div style="margin-top: 8px; font-size: 14px; color: #666;">📞 ' + order.customer.phone + '</div>' : '') +
    '</td></tr>' +

    // Items to fulfill
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #000; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #000; padding-bottom: 8px;">Vinyl to Pack & Ship</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr style="background: #f9fafb;">' +
    '<th style="padding: 10px 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #666;">Release</th>' +
    '<th style="padding: 10px 12px; text-align: center; font-size: 12px; text-transform: uppercase; color: #666;">Qty</th>' +
    '<th style="padding: 10px 12px; text-align: right; font-size: 12px; text-transform: uppercase; color: #666;">Value</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #000;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Total Vinyl Value</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + vinylTotal.toFixed(2) + '</td>' +
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Customer email for reference
    '<tr><td style="padding: 16px; background: #f9fafb; border-radius: 8px;">' +
    '<div style="font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer Email</div>' +
    '<div style="font-size: 14px; color: #111;">' + order.customer.email + '</div>' +
    '</td></tr>' +

    // Instructions
    '<tr><td style="padding-top: 24px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order as soon as possible. Once shipped, please send tracking information to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">This is an automated fulfillment request from Fresh Wax</div>' +
    '<div style="margin-top: 8px;"><a href="https://freshwax.co.uk" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}
