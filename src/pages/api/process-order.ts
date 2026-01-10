// src/pages/api/process-order.ts
// Comprehensive order processing: payment splits, digital delivery, vinyl dropship
import type { APIRoute } from 'astro';
import { getDocument, getDocumentsBatch, addDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Payment split configuration
// Artist sets their price - they receive 100% of it
// Fees are added ON TOP for the customer
const PAYMENT_CONFIG = {
  stripeFeePercent: 2.9,      // Stripe's percentage
  stripeFeeFixed: 0.30,       // Stripe's fixed fee in GBP
  platformFeePercent: 1,      // Fresh Wax platform fee (1%)
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
// Artist gets their full asking price, fees are added on top for customer
function calculatePaymentSplit(artistPrice: number, quantity: number = 1) {
  // Artist receives their full price
  const artistShare = artistPrice * quantity;

  // Fresh Wax platform fee (1% of artist price) - added to customer price
  const platformFee = artistShare * PAYMENT_CONFIG.platformFeePercent / 100;

  // Calculate total before Stripe fee
  const subtotalBeforeStripe = artistShare + platformFee;

  // Stripe fee is charged on total customer payment
  // Customer pays X, Stripe takes 2.9% + 30p, so:
  // X - (0.029*X + 0.30) = subtotalBeforeStripe
  // X * 0.971 = subtotalBeforeStripe + 0.30
  // X = (subtotalBeforeStripe + 0.30) / 0.971
  const customerPays = (subtotalBeforeStripe + PAYMENT_CONFIG.stripeFeeFixed) / (1 - PAYMENT_CONFIG.stripeFeePercent / 100);
  const stripeFee = customerPays - subtotalBeforeStripe;

  return {
    totalPrice: Math.round(customerPays * 100) / 100,  // What customer pays
    stripeFee: Math.round(stripeFee * 100) / 100,
    platformFee: Math.round(platformFee * 100) / 100,
    artistShare: Math.round(artistShare * 100) / 100,  // Artist gets their full asking price
  };
}

// Get digital downloads for a release (used for both digital and vinyl purchases)
// Accepts optional cached release data to avoid duplicate fetches
async function getDigitalDownloads(releaseId: string, itemType: string, trackId?: string, cachedRelease?: any) {
  try {
    const releaseData = cachedRelease || await getDocument('releases', releaseId);
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
// Accepts optional cached release data to avoid duplicate fetches
async function getStockistInfo(releaseId: string, cachedRelease?: any) {
  try {
    const releaseData = cachedRelease || await getDocument('releases', releaseId);
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

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

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

    // OPTIMIZATION: Batch fetch all releases in a single API call (avoids N+1 queries)
    const uniqueReleaseIds = [...new Set(orderData.items
      .map((item: any) => item.releaseId || item.productId || item.id)
      .filter(Boolean)
    )] as string[];
    const releaseCache = uniqueReleaseIds.length > 0
      ? await getDocumentsBatch('releases', uniqueReleaseIds)
      : new Map<string, any>();

    log.info('[process-order] Batch fetched', releaseCache.size, 'releases for', orderData.items.length, 'items');

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
        const cachedRelease = releaseCache.get(releaseId);
        const downloads = await getDigitalDownloads(releaseId, itemType, item.trackId, cachedRelease);
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
              stripeFee: paymentSplit.stripeFee,
              platformFee: paymentSplit.platformFee,
              customerPaid: paymentSplit.totalPrice,
            });
            artistPayments[downloads.artistId].totalArtistShare += paymentSplit.artistShare;
            artistPayments[downloads.artistId].totalStripeFee = (artistPayments[downloads.artistId].totalStripeFee || 0) + paymentSplit.stripeFee;
            artistPayments[downloads.artistId].totalPlatformFee = (artistPayments[downloads.artistId].totalPlatformFee || 0) + paymentSplit.platformFee;
            artistPayments[downloads.artistId].totalCustomerPaid = (artistPayments[downloads.artistId].totalCustomerPaid || 0) + paymentSplit.totalPrice;
          }
        }
      }

      // Vinyl - get stockist for dropship
      if (isVinyl && releaseId) {
        const cachedReleaseForStockist = releaseCache.get(releaseId);
        const stockist = await getStockistInfo(releaseId, cachedReleaseForStockist);
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
      status: hasPhysicalItems ? 'processing' : 'completed',
      orderStatus: hasPhysicalItems ? 'processing' : 'completed',
      createdAt: now,
      updatedAt: now,
    };

    // Save order to Firestore
    const orderRef = await addDocument('orders', order);
    log.info('[process-order] Created order:', orderNumber, orderRef.id);

    // Send all notification emails in parallel for better performance
    const emailPromises: Promise<void>[] = [];
    const emailUrl = new URL('/api/send-order-emails', request.url).toString();

    // Customer confirmation email
    emailPromises.push(
      fetch(emailUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'customer', orderId: orderRef.id, orderNumber, order })
      }).then(() => {}).catch(e => log.error('[process-order] Customer email failed:', e))
    );

    // Artist payment notifications
    for (const artistPayment of Object.values(artistPayments)) {
      emailPromises.push(
        fetch(emailUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'artist', orderId: orderRef.id, orderNumber, artistPayment })
        }).then(() => {}).catch(e => log.error('[process-order] Artist email failed:', e))
      );
    }

    // Stockist fulfillment emails
    for (const stockistOrder of Object.values(stockistOrders)) {
      emailPromises.push(
        fetch(emailUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'stockist', orderId: orderRef.id, orderNumber, stockistOrder,
            customer: order.customer, shipping: order.shipping
          })
        }).then(() => {}).catch(e => log.error('[process-order] Stockist email failed:', e))
      );
    }

    // Wait for all emails to be sent
    await Promise.all(emailPromises);

    // Update customer order count
    if (orderData.customer.userId) {
      try {
        const customerDoc = await getDocument('users', orderData.customer.userId);
        if (customerDoc) {
          await updateDocument('users', orderData.customer.userId, {
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
