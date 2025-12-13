// src/pages/api/process-order.ts
// Comprehensive order processing: payment splits, digital delivery, vinyl dropship
import type { APIRoute } from 'astro';
import { getDocument, addDocument, updateDocument, queryCollection } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Payment split configuration
const PAYMENT_CONFIG = {
  stripeFeePercent: 2.9,      // Stripe's percentage
  stripeFeeFixed: 0.30,       // Stripe's fixed fee in GBP
  platformFeePercent: 15,     // Fresh Wax platform fee
};

function generateOrderNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return 'FW-' + year + month + day + '-' + random;
}

// Calculate payment splits for an item
function calculatePaymentSplit(itemPrice: number, quantity: number = 1) {
  const totalPrice = itemPrice * quantity;

  // Stripe fees (2.9% + 30p)
  const stripeFee = (totalPrice * PAYMENT_CONFIG.stripeFeePercent / 100) + PAYMENT_CONFIG.stripeFeeFixed;

  // Fresh Wax platform fee (15% of item price)
  const platformFee = totalPrice * PAYMENT_CONFIG.platformFeePercent / 100;

  // Artist/Label/Producer gets the rest
  const artistShare = totalPrice - stripeFee - platformFee;

  return {
    totalPrice: Math.round(totalPrice * 100) / 100,
    stripeFee: Math.round(stripeFee * 100) / 100,
    platformFee: Math.round(platformFee * 100) / 100,
    artistShare: Math.round(artistShare * 100) / 100,
  };
}

// Get digital downloads for a release (used for both digital and vinyl purchases)
async function getDigitalDownloads(releaseId: string, itemType: string, trackId?: string) {
  try {
    const releaseData = await getDocument('releases', releaseId);
    if (!releaseData) return null;

    const artistName = releaseData?.artistName || 'Unknown Artist';
    const releaseName = releaseData?.releaseName || releaseData?.title || 'Release';
    const artistId = releaseData?.artistId || releaseData?.userId || null;
    const artistEmail = releaseData?.artistEmail || null;
    const labelName = releaseData?.labelName || releaseData?.label || null;

    // If buying individual track
    if (itemType === 'track' && trackId) {
      const track = (releaseData?.tracks || []).find((t: any) =>
        t.id === trackId || t.trackId === trackId || String(t.trackNumber) === String(trackId)
      );
      if (track) {
        return {
          artistId,
          artistEmail,
          artistName,
          labelName,
          releaseName,
          artworkUrl: releaseData?.artworkUrl || null,
          tracks: [{
            name: track.trackName || track.name,
            mp3Url: track.mp3Url || null,
            wavUrl: track.wavUrl || null
          }]
        };
      }
    }

    // Full release (digital or vinyl - vinyl includes digital)
    return {
      artistId,
      artistEmail,
      artistName,
      labelName,
      releaseName,
      artworkUrl: releaseData?.artworkUrl || null,
      tracks: (releaseData?.tracks || []).map((t: any) => ({
        name: t.trackName || t.name,
        mp3Url: t.mp3Url || null,
        wavUrl: t.wavUrl || null
      }))
    };
  } catch (e) {
    log.error('[process-order] Error fetching release:', e);
    return null;
  }
}

// Get stockist info for vinyl
async function getStockistInfo(releaseId: string) {
  try {
    const releaseData = await getDocument('releases', releaseId);
    if (!releaseData) return null;

    const stockistId = releaseData?.stockistId || releaseData?.supplierId;

    if (!stockistId) {
      // Check suppliers collection for default vinyl supplier
      const suppliers = await queryCollection('suppliers', {
        filters: [
          { field: 'type', op: 'EQUAL', value: 'vinyl' },
          { field: 'isDefault', op: 'EQUAL', value: true }
        ],
        limit: 1
      });

      if (suppliers.length > 0) {
        const supplier = suppliers[0];
        return {
          stockistId: supplier.id,
          stockistName: supplier.name,
          stockistEmail: supplier.email,
          stockistPhone: supplier.phone || null,
        };
      }
      return null;
    }

    const stockist = await getDocument('suppliers', stockistId);
    if (!stockist) return null;

    return {
      stockistId,
      stockistName: stockist?.name,
      stockistEmail: stockist?.email,
      stockistPhone: stockist?.phone || null,
    };
  } catch (e) {
    log.error('[process-order] Error fetching stockist:', e);
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const orderData = await request.json();
    log.info('[process-order] Processing order for:', orderData.customer?.email);

    // Validation
    if (!orderData.customer?.email || !orderData.customer?.firstName || !orderData.customer?.lastName) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required customer information' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (!orderData.items || orderData.items.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'No items in order' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const hasPhysicalItems = orderData.items.some((item: any) =>
      item.type === 'vinyl' || item.type === 'merch' || item.productType === 'vinyl' || item.productType === 'merch'
    );

    if (hasPhysicalItems && !orderData.shipping?.address1) {
      return new Response(JSON.stringify({ success: false, error: 'Shipping address required for physical items' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const orderNumber = generateOrderNumber();
    const now = new Date().toISOString();

    // Process each item
    const processedItems = [];
    const artistPayments: Record<string, any> = {};
    const stockistOrders: Record<string, any> = {};

    for (const item of orderData.items) {
      const releaseId = item.releaseId || item.productId || item.id;
      const itemType = item.type || item.productType || 'digital';
      const isVinyl = itemType === 'vinyl';
      const isDigital = itemType === 'digital' || itemType === 'release' || itemType === 'track';
      const isMerch = itemType === 'merch';
      const isGiftCard = itemType === 'giftcard';

      // Calculate payment split
      const paymentSplit = calculatePaymentSplit(item.price, item.quantity);

      const processedItem: any = {
        ...item,
        releaseId,
        paymentSplit,
      };

      // Digital downloads (for digital purchases AND vinyl purchases)
      if ((isDigital || isVinyl) && releaseId) {
        const downloads = await getDigitalDownloads(releaseId, itemType, item.trackId);
        if (downloads) {
          processedItem.downloads = downloads;
          processedItem.includesDigital = true;

          // Track artist payment
          if (downloads.artistId) {
            if (!artistPayments[downloads.artistId]) {
              artistPayments[downloads.artistId] = {
                artistId: downloads.artistId,
                artistEmail: downloads.artistEmail,
                artistName: downloads.artistName,
                labelName: downloads.labelName,
                items: [],
                totalArtistShare: 0,
              };
            }
            artistPayments[downloads.artistId].items.push({
              name: item.name,
              type: itemType,
              price: item.price,
              quantity: item.quantity,
              artistShare: paymentSplit.artistShare,
            });
            artistPayments[downloads.artistId].totalArtistShare += paymentSplit.artistShare;
          }
        }
      }

      // Vinyl - get stockist for dropship
      if (isVinyl && releaseId) {
        const stockist = await getStockistInfo(releaseId);
        if (stockist) {
          processedItem.stockist = stockist;
          processedItem.requiresDropship = true;

          // Track stockist order
          if (!stockistOrders[stockist.stockistId]) {
            stockistOrders[stockist.stockistId] = {
              ...stockist,
              items: [],
              totalAmount: 0,
            };
          }
          stockistOrders[stockist.stockistId].items.push({
            name: item.name,
            releaseId,
            quantity: item.quantity,
            vinylColor: item.color || item.vinylColor || 'Standard Black',
          });
          // Stockist gets cost price (we'd need to store this - for now using 60% of retail)
          const stockistCost = item.price * 0.6 * item.quantity;
          stockistOrders[stockist.stockistId].totalAmount += stockistCost;
        }
      }

      // Merch handling
      if (isMerch) {
        processedItem.requiresShipping = true;
        // Merch supplier notification would go here
      }

      // Gift card - no physical delivery
      if (isGiftCard) {
        processedItem.isDigitalDelivery = true;
      }

      processedItems.push(processedItem);
    }

    // Calculate order totals with all splits
    const totalStripeFees = processedItems.reduce((sum, item) => sum + item.paymentSplit.stripeFee, 0);
    const totalPlatformFees = processedItems.reduce((sum, item) => sum + item.paymentSplit.platformFee, 0);
    const totalArtistPayments = Object.values(artistPayments).reduce((sum: number, ap: any) => sum + ap.totalArtistShare, 0);

    // Create order document
    const order = {
      orderNumber,
      customer: {
        email: orderData.customer.email,
        firstName: orderData.customer.firstName,
        lastName: orderData.customer.lastName,
        phone: orderData.customer.phone || '',
        userId: orderData.customer.userId || null,
      },
      shipping: orderData.shipping || null,
      items: processedItems,
      totals: {
        subtotal: orderData.totals.subtotal,
        shipping: orderData.totals.shipping,
        total: orderData.totals.total,
        stripeFees: Math.round(totalStripeFees * 100) / 100,
        platformFees: Math.round(totalPlatformFees * 100) / 100,
        artistPayments: Math.round(totalArtistPayments * 100) / 100,
      },
      artistPayments: Object.values(artistPayments),
      stockistOrders: Object.values(stockistOrders),
      hasPhysicalItems,
      hasDigitalItems: processedItems.some(item => item.downloads || item.isDigitalDelivery),
      hasVinylItems: processedItems.some(item => item.requiresDropship),
      paymentMethod: orderData.paymentMethod || 'stripe',
      paymentStatus: 'completed',
      orderStatus: hasPhysicalItems ? 'processing' : 'completed',
      createdAt: now,
      updatedAt: now,
    };

    // Save order to Firestore
    const orderRef = await addDocument('orders', order);
    log.info('[process-order] Created order:', orderNumber, orderRef.id);

    // Send customer confirmation email with download links
    try {
      await fetch(new URL('/api/send-order-emails', request.url).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'customer',
          orderId: orderRef.id,
          orderNumber,
          order,
        })
      });
    } catch (e) { log.error('[process-order] Customer email failed:', e); }

    // Send artist payment notifications
    for (const artistPayment of Object.values(artistPayments)) {
      try {
        await fetch(new URL('/api/send-order-emails', request.url).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'artist',
            orderId: orderRef.id,
            orderNumber,
            artistPayment,
          })
        });
      } catch (e) { log.error('[process-order] Artist email failed:', e); }
    }

    // Send stockist fulfillment emails for vinyl dropship
    for (const stockistOrder of Object.values(stockistOrders)) {
      try {
        await fetch(new URL('/api/send-order-emails', request.url).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'stockist',
            orderId: orderRef.id,
            orderNumber,
            stockistOrder,
            customer: order.customer,
            shipping: order.shipping,
          })
        });
      } catch (e) { log.error('[process-order] Stockist email failed:', e); }
    }

    // Update customer order count
    if (orderData.customer.userId) {
      try {
        const customerDoc = await getDocument('customers', orderData.customer.userId);
        if (customerDoc) {
          await updateDocument('customers', orderData.customer.userId, {
            orderCount: (customerDoc.orderCount || 0) + 1,
            lastOrderAt: now,
          });
        }
      } catch (e) { log.error('[process-order] Error updating customer:', e); }
    }

    return new Response(JSON.stringify({
      success: true,
      orderId: orderRef.id,
      orderNumber,
      hasDigitalDownloads: order.hasDigitalItems,
      downloadLinks: processedItems
        .filter(item => item.downloads)
        .map(item => ({
          name: item.name,
          tracks: item.downloads.tracks,
        })),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[process-order] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process order',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
