// src/lib/order-utils.ts
// Shared order creation utilities for PayPal and Stripe payment flows

import { getDocument, updateDocument, addDocument, clearCache, setDocument } from './firebase-rest';
import { d1UpsertMerch } from './d1-catalog';
import { sendVinylOrderSellerEmail, sendVinylOrderAdminEmail } from './vinyl-order-emails';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Generate order number
export function generateOrderNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FW-${year}${month}${day}-${random}`;
}

// Get short order number for display (e.g., "FW-ABC123" from "FW-241204-abc123")
export function getShortOrderNumber(orderNumber: string): string {
  const orderParts = orderNumber.split('-');
  return orderParts.length >= 3
    ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
    : orderNumber.toUpperCase();
}

// Process cart items to add download URLs
export async function processItemsWithDownloads(items: any[]): Promise<any[]> {
  return Promise.all(items.map(async (item: any) => {
    const releaseId = item.releaseId || item.productId || item.id;

    log.info('[order-utils] Processing item:', item.name, 'type:', item.type, 'releaseId:', releaseId);

    // Check if this is a digital release, track, or vinyl
    if (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.type === 'vinyl' || (!item.type && releaseId)) {
      try {
        log.info('[order-utils] Fetching release from Firebase:', releaseId);
        const releaseData = await getDocument('releases', releaseId);

        if (releaseData) {
          log.info('[order-utils] Release found:', releaseData?.releaseName);

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

            const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
            const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';
            const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;

            if (track) {
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
          const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;

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

          return {
            ...item,
            releaseId,
            artwork: artworkUrl,
            image: artworkUrl,
            downloads
          };
        }
      } catch (e) {
        console.error('[order-utils] Error fetching release:', releaseId, e);
      }
    }
    return { ...item, releaseId };
  }));
}

// Update stock for vinyl items
export async function updateVinylStock(items: any[], orderNumber: string, orderId: string, idToken?: string): Promise<void> {
  const now = new Date().toISOString();

  for (const item of items) {
    if (item.type === 'vinyl' && (item.releaseId || item.productId)) {
      const releaseId = item.releaseId || item.productId;
      try {
        log.info('[order-utils] Updating vinyl stock for:', item.name, 'qty:', item.quantity);

        const releaseData = await getDocument('releases', releaseId);

        if (releaseData && releaseData.vinylStock !== undefined) {
          const previousStock = releaseData.vinylStock || 0;
          const newStock = Math.max(0, previousStock - (item.quantity || 1));

          await updateDocument('releases', releaseId, {
            vinylStock: newStock,
            vinylSold: (releaseData.vinylSold || 0) + (item.quantity || 1),
            updatedAt: now
          });

          // Record stock movement
          await addDocument('vinyl-stock-movements', {
            releaseId: releaseId,
            releaseName: item.name || releaseData.releaseName,
            type: 'sell',
            quantity: item.quantity || 1,
            stockDelta: -(item.quantity || 1),
            previousStock: previousStock,
            newStock: newStock,
            orderId: orderId,
            orderNumber: orderNumber,
            notes: 'Order ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);

          log.info('[order-utils] ✓ Vinyl stock updated:', item.name, previousStock, '->', newStock);
        }
      } catch (stockErr) {
        console.error('[order-utils] Vinyl stock update error:', stockErr);
      }
    }
  }
}

// Process vinyl crates orders (marketplace items from sellers)
// Creates order records for sellers, marks listings as sold, and sends notifications
export async function processVinylCratesOrders(
  items: any[],
  orderNumber: string,
  orderId: string,
  customer: { email: string; firstName: string; lastName: string },
  shipping: any,
  env?: any,
  idToken?: string
): Promise<void> {
  const now = new Date().toISOString();

  // Filter for crates items (have sellerId - these are marketplace items, not new releases)
  const cratesItems = items.filter(item =>
    item.type === 'vinyl' && item.sellerId && !item.releaseId
  );

  if (cratesItems.length === 0) {
    log.info('[order-utils] No vinyl crates items to process');
    return;
  }

  log.info('[order-utils] Processing', cratesItems.length, 'vinyl crates items');

  for (const item of cratesItems) {
    try {
      const listingId = item.id;
      const sellerId = item.sellerId;
      const sellerName = item.sellerName || 'Unknown Seller';

      log.info('[order-utils] Processing crates item:', item.title, 'from seller:', sellerName);

      // 1. Mark the listing as sold
      try {
        await updateDocument('vinylListings', listingId, {
          status: 'sold',
          soldAt: now,
          soldOrderNumber: orderNumber,
          soldOrderId: orderId,
          soldTo: customer.email,
          updatedAt: now
        });
        log.info('[order-utils] ✓ Listing marked as sold:', listingId);
      } catch (markSoldErr) {
        console.error('[order-utils] Failed to mark listing as sold:', markSoldErr);
      }

      // 2. Create vinyl order record for the seller
      const vinylOrder = {
        orderId: orderId,
        orderNumber: orderNumber,
        listingId: listingId,
        sellerId: sellerId,
        sellerName: sellerName,
        title: item.title || item.name,
        artist: item.artist,
        price: item.price,
        originalPrice: item.originalPrice || item.price,
        discountPercent: item.discountPercent || 0,
        shippingCost: item.shippingCost || 0,
        format: item.format,
        condition: item.condition,
        image: item.image,
        buyer: {
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          name: `${customer.firstName} ${customer.lastName}`
        },
        shipping: shipping,
        status: 'pending', // Seller needs to ship
        createdAt: now,
        updatedAt: now
      };

      try {
        const vinylOrderId = `vo_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        await setDocument('vinylOrders', vinylOrderId, vinylOrder);
        log.info('[order-utils] ✓ Vinyl order created:', vinylOrderId);
      } catch (orderErr) {
        console.error('[order-utils] Failed to create vinyl order:', orderErr);
      }

      // 3. Get seller email and send notifications
      let sellerEmail = '';
      try {
        // Try to get seller email from vinylSellers collection (or vinyl-sellers for legacy)
        let seller = await getDocument('vinylSellers', sellerId);
        if (!seller) {
          seller = await getDocument('vinyl-sellers', sellerId);
        }
        if (seller) {
          sellerEmail = seller?.email || '';
        }
        // Also try users collection
        if (!sellerEmail) {
          const user = await getDocument('users', sellerId);
          sellerEmail = user?.email || '';
        }
      } catch (e) {
        log.info('[order-utils] Could not fetch seller email');
      }

      // Send seller notification
      if (sellerEmail) {
        try {
          await sendVinylOrderSellerEmail(
            sellerEmail,
            sellerName,
            {
              orderNumber,
              itemTitle: item.title || item.name,
              itemArtist: item.artist,
              price: item.price,
              buyerName: `${customer.firstName} ${customer.lastName}`,
              buyerEmail: customer.email,
              shippingAddress: shipping
            },
            env
          );
          log.info('[order-utils] ✓ Seller email sent to:', sellerEmail);
        } catch (emailErr) {
          console.error('[order-utils] Seller email failed:', emailErr);
        }
      }

      // Send admin notification
      try {
        await sendVinylOrderAdminEmail(
          {
            orderNumber,
            sellerId,
            sellerName,
            sellerEmail: sellerEmail || 'unknown',
            itemTitle: item.title || item.name,
            itemArtist: item.artist,
            price: item.price,
            buyerName: `${customer.firstName} ${customer.lastName}`,
            buyerEmail: customer.email
          },
          env
        );
        log.info('[order-utils] ✓ Admin email sent');
      } catch (adminEmailErr) {
        console.error('[order-utils] Admin email failed:', adminEmailErr);
      }

    } catch (err) {
      console.error('[order-utils] Error processing crates item:', err);
    }
  }
}

// Refund stock when order is cancelled
export async function refundOrderStock(orderId: string, items: any[], orderNumber: string, idToken?: string, env?: any): Promise<void> {
  const now = new Date().toISOString();

  for (const item of items) {
    // Refund merch stock
    if (item.type === 'merch' && item.productId) {
      try {
        log.info('[order-utils] Refunding merch stock for:', item.name, 'qty:', item.quantity);

        const productData = await getDocument('merch', item.productId);

        if (productData) {
          const variantStock = productData.variantStock || {};
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          let variantKey = size + '_' + color;

          if (!variantStock[variantKey]) {
            const keys = Object.keys(variantStock);
            if (keys.length === 1) variantKey = keys[0];
          }

          const variant = variantStock[variantKey];

          if (variant) {
            const previousStock = variant.stock || 0;
            const newStock = previousStock + (item.quantity || 1);

            variant.stock = newStock;
            variant.sold = Math.max(0, (variant.sold || 0) - (item.quantity || 1));
            variantStock[variantKey] = variant;

            let totalStock = 0;
            let totalSold = 0;
            Object.values(variantStock).forEach((v: any) => {
              totalStock += v.stock || 0;
              totalSold += v.sold || 0;
            });

            await updateDocument('merch', item.productId, {
              variantStock: variantStock,
              totalStock: totalStock,
              soldStock: totalSold,
              isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
              isOutOfStock: totalStock === 0,
              updatedAt: now
            });

            // Record refund movement
            await addDocument('merch-stock-movements', {
              productId: item.productId,
              productName: item.name,
              sku: productData.sku,
              variantKey: variantKey,
              variantSku: variant.sku,
              type: 'return',
              quantity: item.quantity || 1,
              stockDelta: item.quantity || 1,
              previousStock: previousStock,
              newStock: newStock,
              orderId: orderId,
              orderNumber: orderNumber,
              notes: 'Order cancelled - ' + orderNumber,
              createdAt: now,
              createdBy: 'system'
            }, idToken);

            log.info('[order-utils] ✓ Merch stock refunded:', item.name, previousStock, '->', newStock);

            // Sync to D1
            const db = env?.DB;
            if (db) {
              try {
                clearCache(`doc:merch:${item.productId}`);
                const updatedProduct = await getDocument('merch', item.productId);
                if (updatedProduct) {
                  await d1UpsertMerch(db, item.productId, updatedProduct);
                  log.info('[order-utils] ✓ D1 synced after refund:', item.name);
                }
              } catch (d1Error) {
                log.error('[order-utils] D1 sync failed (non-critical):', d1Error);
              }
            }
          }
        }
      } catch (refundErr) {
        console.error('[order-utils] Merch refund error:', refundErr);
      }
    }

    // Refund vinyl stock
    if (item.type === 'vinyl' && (item.releaseId || item.productId)) {
      const releaseId = item.releaseId || item.productId;
      try {
        log.info('[order-utils] Refunding vinyl stock for:', item.name, 'qty:', item.quantity);

        const releaseData = await getDocument('releases', releaseId);

        if (releaseData) {
          const previousStock = releaseData.vinylStock || 0;
          const newStock = previousStock + (item.quantity || 1);

          await updateDocument('releases', releaseId, {
            vinylStock: newStock,
            vinylSold: Math.max(0, (releaseData.vinylSold || 0) - (item.quantity || 1)),
            updatedAt: now
          });

          await addDocument('vinyl-stock-movements', {
            releaseId: releaseId,
            releaseName: item.name || releaseData.releaseName,
            type: 'return',
            quantity: item.quantity || 1,
            stockDelta: item.quantity || 1,
            previousStock: previousStock,
            newStock: newStock,
            orderId: orderId,
            orderNumber: orderNumber,
            notes: 'Order cancelled - ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);

          log.info('[order-utils] ✓ Vinyl stock refunded:', item.name, previousStock, '->', newStock);
        }
      } catch (refundErr) {
        console.error('[order-utils] Vinyl refund error:', refundErr);
      }
    }
  }
}

// Update stock for merch items
export async function updateMerchStock(items: any[], orderNumber: string, orderId: string, idToken?: string, env?: any): Promise<void> {
  const now = new Date().toISOString();

  for (const item of items) {
    if (item.type === 'merch' && item.productId) {
      try {
        log.info('[order-utils] Updating stock for merch item:', item.name, 'qty:', item.quantity);

        const productData = await getDocument('merch', item.productId);

        if (productData) {
          const variantStock = productData.variantStock || {};

          // Build variant key from size and color
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          let variantKey = size + '_' + color;

          // Check if variant exists, otherwise try default
          if (!variantStock[variantKey]) {
            const keys = Object.keys(variantStock);
            if (keys.length === 1) {
              variantKey = keys[0];
            } else {
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
              orderId: orderId,
              orderNumber: orderNumber,
              notes: 'Order ' + orderNumber,
              createdAt: now,
              createdBy: 'system'
            }, idToken);

            log.info('[order-utils] ✓ Stock updated:', item.name, variantKey, previousStock, '->', newStock);

            // Sync to D1 so public merch page shows updated stock
            const db = env?.DB;
            if (db) {
              try {
                clearCache(`doc:merch:${item.productId}`);
                const updatedProduct = await getDocument('merch', item.productId);
                if (updatedProduct) {
                  await d1UpsertMerch(db, item.productId, updatedProduct);
                  log.info('[order-utils] ✓ D1 synced for:', item.name);
                }
              } catch (d1Error) {
                log.error('[order-utils] D1 sync failed (non-critical):', d1Error);
              }
            }

            // Update supplier stats if applicable
            if (productData.supplierId) {
              try {
                const supplierRevenue = (productData.retailPrice || item.price) * item.quantity * ((productData.supplierCut || 0) / 100);
                const supplierData = await getDocument('merch-suppliers', productData.supplierId);
                if (supplierData) {
                  await updateDocument('merch-suppliers', productData.supplierId, {
                    totalStock: (supplierData.totalStock || 0) - item.quantity,
                    totalSold: (supplierData.totalSold || 0) + item.quantity,
                    totalRevenue: (supplierData.totalRevenue || 0) + supplierRevenue,
                    updatedAt: now
                  });
                }
              } catch (supplierErr) {
                log.info('[order-utils] Could not update supplier stats');
              }
            }
          }
        }
      } catch (stockErr) {
        console.error('[order-utils] Stock update error:', stockErr);
      }
    }
  }
}

// Send order confirmation email
export async function sendOrderConfirmationEmail(
  order: any,
  orderId: string,
  orderNumber: string,
  env: any
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

  console.log('[sendEmail] Attempting to send confirmation email');
  console.log('[sendEmail]   - RESEND_API_KEY exists:', !!RESEND_API_KEY);
  console.log('[sendEmail]   - Customer email:', order.customer?.email || 'MISSING');

  if (!RESEND_API_KEY || !order.customer?.email) {
    console.log('[sendEmail] ⚠️ Skipping email - no API key or no customer email');
    return;
  }

  try {
    console.log('[sendEmail] Sending email to:', order.customer.email);
    const shortOrderNumber = getShortOrderNumber(orderNumber);
    const emailHtml = buildOrderConfirmationEmail(orderId, shortOrderNumber, order);

    console.log('[sendEmail] Email HTML length:', emailHtml.length);

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <orders@freshwax.co.uk>',
        to: [order.customer.email],
        bcc: ['freshwaxonline@gmail.com'],
        subject: 'Order Confirmed - ' + shortOrderNumber,
        html: emailHtml
      })
    });

    console.log('[sendEmail] Resend API response status:', emailResponse.status);

    if (emailResponse.ok) {
      const emailResult = await emailResponse.json();
      console.log('[sendEmail] ✅ Email sent! ID:', emailResult.id);
    } else {
      const error = await emailResponse.text();
      console.error('[sendEmail] ❌ Email failed:', emailResponse.status, error);
    }
  } catch (emailError) {
    console.error('[sendEmail] ❌ Exception:', emailError);
  }
}

// Send vinyl fulfillment email to stockist
export async function sendVinylFulfillmentEmail(
  order: any,
  orderId: string,
  orderNumber: string,
  vinylItems: any[],
  env: any
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  const STOCKIST_EMAIL = env?.VINYL_STOCKIST_EMAIL || import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

  if (!RESEND_API_KEY || !STOCKIST_EMAIL) return;

  try {
    log.info('[order-utils] Sending vinyl fulfillment email to stockist:', STOCKIST_EMAIL);
    const fulfillmentHtml = buildStockistFulfillmentEmail(orderId, orderNumber, order, vinylItems);

    const fulfillmentResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
        to: [STOCKIST_EMAIL],
        bcc: ['freshwaxonline@gmail.com'],
        subject: '📦 VINYL FULFILLMENT REQUIRED - ' + orderNumber,
        html: fulfillmentHtml
      })
    });

    if (fulfillmentResponse.ok) {
      log.info('[order-utils] ✓ Stockist email sent!');
    } else {
      const error = await fulfillmentResponse.text();
      console.error('[order-utils] ❌ Stockist email failed:', error);
    }
  } catch (stockistError) {
    console.error('[order-utils] Stockist email error:', stockistError);
  }
}

// Send digital sale notification to artists
export async function sendDigitalSaleEmails(
  order: any,
  orderNumber: string,
  digitalItems: any[],
  env: any
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  // Group items by artist email
  const itemsByArtist: { [email: string]: any[] } = {};
  for (const item of digitalItems) {
    const artistEmail = item.artistEmail;
    if (artistEmail) {
      if (!itemsByArtist[artistEmail]) {
        itemsByArtist[artistEmail] = [];
      }
      itemsByArtist[artistEmail].push(item);
    }
  }

  // Send email to each artist
  for (const [artistEmail, items] of Object.entries(itemsByArtist)) {
    try {
      log.info('[order-utils] Sending digital sale email to artist:', artistEmail);
      const digitalHtml = buildDigitalSaleEmail(orderNumber, order, items);

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Fresh Wax <orders@freshwax.co.uk>',
          to: [artistEmail],
          bcc: ['freshwaxonline@gmail.com'],
          subject: '🎵 Digital Sale! ' + orderNumber,
          html: digitalHtml
        })
      });
      log.info('[order-utils] ✓ Digital sale email sent to:', artistEmail);
    } catch (digitalError) {
      console.error('[order-utils] Digital sale email error:', digitalError);
    }
  }
}

// Send merch sale notification to sellers
export async function sendMerchSaleEmails(
  order: any,
  orderNumber: string,
  merchItems: any[],
  env: any
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  // Group items by seller email
  const itemsBySeller: { [email: string]: any[] } = {};
  for (const item of merchItems) {
    const sellerEmail = item.stockistEmail || item.artistEmail || item.sellerEmail;
    if (sellerEmail) {
      if (!itemsBySeller[sellerEmail]) {
        itemsBySeller[sellerEmail] = [];
      }
      itemsBySeller[sellerEmail].push(item);
    }
  }

  // Send email to each seller
  for (const [sellerEmail, items] of Object.entries(itemsBySeller)) {
    try {
      log.info('[order-utils] Sending merch sale email to seller:', sellerEmail);
      const merchHtml = buildMerchSaleEmail(orderNumber, order, items);

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
          to: [sellerEmail],
          bcc: ['freshwaxonline@gmail.com'],
          subject: '👕 Merch Order! ' + orderNumber,
          html: merchHtml
        })
      });
      log.info('[order-utils] ✓ Merch sale email sent to:', sellerEmail);
    } catch (merchError) {
      console.error('[order-utils] Merch sale email error:', merchError);
    }
  }
}

// Update customer order count
export async function updateCustomerOrderCount(userId: string): Promise<void> {
  if (!userId) return;

  try {
    const customerDoc = await getDocument('users', userId);
    if (customerDoc) {
      await updateDocument('users', userId, {
        orderCount: (customerDoc.orderCount || 0) + 1,
        lastOrderAt: new Date().toISOString()
      });
    }
  } catch (e) {
    console.error('[order-utils] Error updating customer:', e);
  }
}

// Main function to create a complete order
export interface CreateOrderParams {
  orderData: {
    customer: {
      email: string;
      firstName: string;
      lastName: string;
      phone?: string;
      userId?: string;
    };
    shipping?: {
      address1: string;
      address2?: string;
      city: string;
      county?: string;
      postcode: string;
      country: string;
    };
    items: any[];
    totals: {
      subtotal: number;
      shipping: number;
      freshWaxFee?: number;
      stripeFee?: number;
      serviceFees?: number;
      total: number;
    };
    hasPhysicalItems: boolean;
    paymentMethod: string;
    paymentIntentId?: string;
    paypalOrderId?: string;
  };
  env: any;
  idToken?: string;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  orderNumber?: string;
  error?: string;
}

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  console.log('[createOrder] ========== CREATE ORDER CALLED ==========');
  const { orderData, env, idToken } = params;
  const now = new Date().toISOString();
  const orderNumber = generateOrderNumber();

  console.log('[createOrder] Order number:', orderNumber);
  console.log('[createOrder] Customer:', orderData.customer?.email);
  console.log('[createOrder] Items count:', orderData.items?.length || 0);
  console.log('[createOrder] Total:', orderData.totals?.total);
  console.log('[createOrder] env available:', !!env);
  console.log('[createOrder] idToken available:', !!idToken);

  try {
    // Process items with download URLs
    console.log('[createOrder] Processing items with downloads...');
    const itemsWithDownloads = await processItemsWithDownloads(orderData.items);
    console.log('[createOrder] Items processed:', itemsWithDownloads.length);

    // Check for pre-orders
    const hasPreOrderItems = itemsWithDownloads.some((item: any) => item.isPreOrder === true);
    const preOrderReleaseDates = itemsWithDownloads
      .filter((item: any) => item.isPreOrder && item.releaseDate)
      .map((item: any) => new Date(item.releaseDate));
    const latestPreOrderDate = preOrderReleaseDates.length > 0
      ? new Date(Math.max(...preOrderReleaseDates.map((d: Date) => d.getTime()))).toISOString()
      : null;

    // Create order document
    const order = {
      orderNumber,
      customer: {
        email: orderData.customer.email,
        firstName: orderData.customer.firstName,
        lastName: orderData.customer.lastName,
        phone: orderData.customer.phone || '',
        userId: orderData.customer.userId || null
      },
      customerId: orderData.customer.userId || null,
      shipping: orderData.shipping || null,
      items: itemsWithDownloads,
      totals: {
        subtotal: orderData.totals.subtotal,
        shipping: orderData.totals.shipping,
        freshWaxFee: orderData.totals.freshWaxFee || 0,
        stripeFee: orderData.totals.stripeFee || 0,
        serviceFees: orderData.totals.serviceFees || 0,
        total: orderData.totals.total
      },
      hasPhysicalItems: orderData.hasPhysicalItems,
      hasPreOrderItems,
      preOrderDeliveryDate: latestPreOrderDate,
      paymentMethod: orderData.paymentMethod,
      paymentIntentId: orderData.paymentIntentId || null,
      paypalOrderId: orderData.paypalOrderId || null,
      paymentStatus: 'completed',
      // Use both status and orderStatus for compatibility
      // status is used by UI pages and update-order-status API
      // orderStatus is legacy field kept for backward compatibility
      status: hasPreOrderItems ? 'awaiting_release' : (orderData.hasPhysicalItems ? 'processing' : 'completed'),
      orderStatus: hasPreOrderItems ? 'awaiting_release' : (orderData.hasPhysicalItems ? 'processing' : 'completed'),
      createdAt: now,
      updatedAt: now
    };

    // Save to Firebase
    console.log('[createOrder] Saving order to Firebase...');
    console.log('[createOrder] Order data keys:', Object.keys(order).join(', '));

    const orderRef = await addDocument('orders', order, idToken);

    console.log('[createOrder] ✅ Order saved to Firebase');
    console.log('[createOrder] Order ID:', orderRef.id);
    console.log('[createOrder] Order Number:', orderNumber);

    // Update stock for merch items (includes D1 sync)
    await updateMerchStock(order.items, orderNumber, orderRef.id, idToken, env);

    // Update stock for vinyl items
    await updateVinylStock(order.items, orderNumber, orderRef.id, idToken);

    // Process vinyl crates orders (marketplace items from sellers)
    await processVinylCratesOrders(
      order.items,
      orderNumber,
      orderRef.id,
      order.customer,
      order.shipping,
      env,
      idToken
    );

    // Send confirmation email
    console.log('[createOrder] Sending confirmation email...');
    console.log('[createOrder]   - RESEND_API_KEY exists:', !!(env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY));
    await sendOrderConfirmationEmail(order, orderRef.id, orderNumber, env);
    console.log('[createOrder] ✓ Confirmation email sent');

    // Send vinyl fulfillment email if applicable
    const vinylItems = order.items.filter((item: any) => item.type === 'vinyl');
    if (vinylItems.length > 0) {
      console.log('[createOrder] Sending vinyl fulfillment email...');
      await sendVinylFulfillmentEmail(order, orderRef.id, orderNumber, vinylItems, env);
    }

    // Send digital sale emails
    const digitalItems = order.items.filter((item: any) =>
      item.type === 'track' || item.type === 'digital' || item.type === 'release'
    );
    if (digitalItems.length > 0) {
      console.log('[createOrder] Sending digital sale emails for', digitalItems.length, 'items');
      await sendDigitalSaleEmails(order, orderNumber, digitalItems, env);
    }

    // Send merch sale emails
    const merchItems = order.items.filter((item: any) => item.type === 'merch');
    if (merchItems.length > 0) {
      console.log('[createOrder] Sending merch sale emails for', merchItems.length, 'items');
      await sendMerchSaleEmails(order, orderNumber, merchItems, env);
    }

    // Update customer order count
    if (orderData.customer.userId) {
      console.log('[createOrder] Updating customer order count...');
      await updateCustomerOrderCount(orderData.customer.userId);
    }

    console.log('[createOrder] ========== ORDER CREATION COMPLETE ==========');
    return {
      success: true,
      orderId: orderRef.id,
      orderNumber
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[createOrder] ❌ ERROR:', errorMessage);
    console.error('[createOrder] Stack:', error instanceof Error ? error.stack : 'no stack');
    return {
      success: false,
      error: errorMessage
    };
  }
}

// ============================================
// EMAIL TEMPLATES
// ============================================

function buildOrderConfirmationEmail(orderId: string, orderNumber: string, order: any): string {
  // Build items HTML - only show image for merch items
  let itemsHtml = '';
  for (const item of order.items) {
    const isMerchItem = item.type === 'merch';
    const itemImage = isMerchItem ? (item.image || item.artwork || '') : '';

    let typeLabel = '';
    if (item.type === 'digital') typeLabel = 'Digital Download';
    else if (item.type === 'track') typeLabel = 'Single Track';
    else if (item.type === 'vinyl') typeLabel = 'Vinyl Record';
    else if (item.type === 'merch') typeLabel = 'Merchandise';
    else typeLabel = item.type || '';

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
    '<tr><td style="background: #000000; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #9ca3af; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +
    '<tr><td style="background: #ffffff; padding: 32px 24px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="width: 56px; height: 56px; background: #dcfce7; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">' +
    '<span style="color: #16a34a; font-size: 28px;">✓</span></div>' +
    '<h1 style="margin: 0; color: #111; font-size: 24px; font-weight: 700;">Order Confirmed!</h1>' +
    '<p style="margin: 8px 0 0; color: #6b7280; font-size: 14px;">Thank you for your purchase</p>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="display: inline-block; background: #f3f4f6; padding: 12px 24px; border-radius: 8px;">' +
    '<div style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>' +
    '<div style="color: #dc2626; font-size: 18px; font-weight: 700; margin-top: 4px;">' + orderNumber + '</div>' +
    '</div></td></tr>' +
    '<tr><td style="border-top: 1px solid #e5e7eb; padding-top: 24px;"></td></tr>' +
    '<tr><td style="padding-bottom: 12px; border-bottom: 1px solid #e5e7eb;">' +
    '<div style="font-weight: 700; color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Order Details</div>' +
    '</td></tr>' +
    '<tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%">' + itemsHtml + '</table></td></tr>' +
    '<tr><td style="padding-top: 16px; border-top: 2px solid #dc2626;"><table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Subtotal</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">£' + order.totals.subtotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Shipping</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">' +
    (order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : '£' + order.totals.shipping.toFixed(2)) : 'Digital delivery') + '</td></tr>' +
    (order.totals.stripeFee ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;">Processing Fee</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.stripeFee.toFixed(2) + '</td></tr>' : '') +
    (order.totals.freshWaxFee ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;"><span style="color: #111;">Fresh</span> <span style="color: #dc2626;">Wax</span> Tax</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.freshWaxFee.toFixed(2) + '</td></tr>' : '') +
    (order.totals.serviceFees && !order.totals.stripeFee && !order.totals.freshWaxFee ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;">Service Fee</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.serviceFees.toFixed(2) + '</td></tr>' : '') +
    '<tr><td colspan="2" style="border-top: 2px solid #dc2626; padding-top: 12px;"></td></tr>' +
    '<tr><td style="color: #111; font-weight: 700; font-size: 16px; padding: 4px 0;">Total</td>' +
    '<td style="color: #dc2626; font-weight: 700; font-size: 20px; text-align: right; padding: 4px 0;">£' + order.totals.total.toFixed(2) + '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td style="height: 24px;"></td></tr>' +
    shippingSection +
    '<tr><td align="center" style="padding: 24px 0 8px;">' +
    '<a href="https://freshwax.co.uk" style="display: inline-block; padding: 14px 32px; background: #000000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Go Back to Store</a>' +
    '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px; line-height: 1.6;">Question? Email us at <a href="mailto:contact@freshwax.co.uk" style="color: #111; text-decoration: underline;">contact@freshwax.co.uk</a></div>' +
    '<div style="margin-top: 12px;"><a href="https://freshwax.co.uk" style="color: #9ca3af; font-size: 12px; text-decoration: none;">freshwax.co.uk</a></div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildStockistFulfillmentEmail(orderId: string, orderNumber: string, order: any, vinylItems: any[]): string {
  const orderDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  let itemsHtml = '';
  for (const item of vinylItems) {
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">' + item.name + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">£' + (item.price * (item.quantity || 1)).toFixed(2) + '</td>' +
      '</tr>';
  }

  const vinylTotal = vinylItems.reduce((sum: number, item: any) => sum + (item.price * (item.quantity || 1)), 0);
  const isTestMode = order.paymentMethod === 'test_mode';
  const paymentStatusColor = order.paymentStatus === 'completed' ? '#16a34a' : '#f59e0b';
  const paymentStatusText = order.paymentStatus === 'completed' ? 'PAID' : 'PENDING';
  const paymentMethodText = isTestMode ? 'Test Mode' : (order.paymentMethod === 'stripe' ? 'Stripe' : order.paymentMethod === 'paypal' ? 'PayPal' : order.paymentMethod || 'Card');

  const artistPayment = order.totals.subtotal;
  const stripeFee = order.totals.stripeFee || 0;
  const freshWaxFee = order.totals.freshWaxFee || 0;
  const customerPaid = order.totals.total;

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 1px;">📦 VINYL FULFILLMENT REQUIRED</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 8px;">Fresh Wax Order</div>' +
    '</td></tr>' +
    '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: ' + (order.paymentStatus === 'completed' ? '#dcfce7' : '#fef3c7') + '; border: 2px solid ' + paymentStatusColor + '; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: ' + paymentStatusColor + '; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">💳 Payment Confirmation</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Status:</td><td style="padding: 4px 0; font-weight: 700; color: ' + paymentStatusColor + '; font-size: 13px;">' + paymentStatusText + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Method:</td><td style="padding: 4px 0; font-weight: 600; color: #111; font-size: 13px;">' + paymentMethodText + '</td></tr>' +
    '</table>' +
    '<div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid ' + paymentStatusColor + ';">' +
    '<div style="font-weight: 700; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #111; font-size: 14px; font-weight: 700;">Your Payment:</td><td style="padding: 4px 0; text-align: right; color: #16a34a; font-size: 14px; font-weight: 700;">£' + artistPayment.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 4px 0 4px 0; border-top: 1px dashed #ccc;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Processing Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">£' + stripeFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Fresh Wax 1% (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Customer Paid:</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div>' +
    (isTestMode ? '<div style="margin-top: 12px; padding: 8px; background: #fef3c7; border-radius: 4px; font-size: 12px; color: #92400e;">⚠️ This is a test order - no real payment was processed</div>' : '') +
    '</td></tr></table></td></tr>' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Details</div>' +
    '<div style="font-size: 24px; font-weight: 800; color: #000; margin-bottom: 4px;">' + orderNumber + '</div>' +
    '<div style="font-size: 14px; color: #666;">' + orderDate + '</div>' +
    '</td></tr></table></td></tr>' +
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
    '</tr></table></td></tr>' +
    '<tr><td style="padding: 16px; background: #f9fafb; border-radius: 8px;">' +
    '<div style="font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer Email</div>' +
    '<div style="font-size: 14px; color: #111;">' + order.customer.email + '</div>' +
    '</td></tr>' +
    '<tr><td style="padding-top: 24px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order as soon as possible. Once shipped, please send tracking information to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div></td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">This is an automated fulfillment request from Fresh Wax</div>' +
    '<div style="margin-top: 8px;"><a href="https://freshwax.co.uk" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildDigitalSaleEmail(orderNumber: string, order: any, digitalItems: any[]): string {
  const digitalTotal = digitalItems.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
  const subtotal = order.totals?.subtotal || digitalTotal;
  // Calculate fees that are deducted from artist share
  const freshWaxFee = digitalTotal * 0.01; // 1% Fresh Wax fee on these items
  const processingFee = (digitalTotal * 0.014) + (0.20 / Math.max(1, digitalItems.length)); // Processing fee split
  // Artist net earnings = gross - fees
  const artistNetEarnings = digitalTotal - freshWaxFee - processingFee;
  const customerPaid = order.totals?.total || subtotal;

  let itemsHtml = '';
  for (const item of digitalItems) {
    const typeLabel = item.type === 'track' ? 'Single Track' : 'Digital Release';
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' + item.name + '<br><span style="font-size: 12px; color: #9ca3af;">' + typeLabel + '</span></td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">£' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">🎵 DIGITAL SALE!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + orderNumber + '</div>' +
    '</td></tr>' +
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your music!</div>' +
    '<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ' + order.customer.firstName + ' ' + order.customer.lastName + '</div>' +
    '</td></tr>' +
    '<tr><td>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #374151; border-radius: 8px; overflow: hidden; background: #1f2937;">' +
    '<tr style="background: #374151;">' +
    '<th style="padding: 12px; text-align: left; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Item</th>' +
    '<th style="padding: 12px; text-align: center; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Qty</th>' +
    '<th style="padding: 12px; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Price</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #dc2626;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Your Earnings</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + artistNetEarnings.toFixed(2) + '</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£' + artistNetEarnings.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Item Price:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + digitalTotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + processingFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Fee (1%):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div></td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    '<div style="margin-top: 8px;"><a href="https://freshwax.co.uk" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildMerchSaleEmail(orderNumber: string, order: any, merchItems: any[]): string {
  const merchTotal = merchItems.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
  const subtotal = order.totals?.subtotal || merchTotal;
  // Calculate fees deducted from supplier share (5% for merch)
  const freshWaxFee = merchTotal * 0.05; // 5% Fresh Wax fee for merch
  const processingFee = (merchTotal * 0.014) + (0.20 / Math.max(1, merchItems.length)); // Processing fee split
  // Supplier net earnings = gross - fees
  const supplierNetEarnings = merchTotal - freshWaxFee - processingFee;
  const customerPaid = order.totals?.total || subtotal;

  let itemsHtml = '';
  for (const item of merchItems) {
    const details = [item.size ? 'Size: ' + item.size : '', item.color || ''].filter(Boolean).join(' • ');
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' +
      (item.image ? '<img src="' + item.image + '" width="50" height="50" style="border-radius: 4px; margin-right: 10px; vertical-align: middle;">' : '') +
      item.name + (details ? '<br><span style="font-size: 12px; color: #9ca3af;">' + details + '</span>' : '') + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">£' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  const shippingHtml = order.shipping ?
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; color: #9ca3af; margin-bottom: 8px; font-size: 12px; text-transform: uppercase;">Ship To</div>' +
    '<div style="color: #fff; line-height: 1.5; font-size: 14px;">' +
    order.customer.firstName + ' ' + order.customer.lastName + '<br>' +
    order.shipping.address1 + '<br>' +
    (order.shipping.address2 ? order.shipping.address2 + '<br>' : '') +
    order.shipping.city + ', ' + order.shipping.postcode + '<br>' +
    order.shipping.country +
    '</div></div></td></tr>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">👕 MERCH ORDER!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + orderNumber + '</div>' +
    '</td></tr>' +
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your merch!</div>' +
    '<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ' + order.customer.firstName + ' ' + order.customer.lastName + '</div>' +
    '</td></tr>' +
    '<tr><td>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #374151; border-radius: 8px; overflow: hidden; background: #1f2937;">' +
    '<tr style="background: #374151;">' +
    '<th style="padding: 12px; text-align: left; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Item</th>' +
    '<th style="padding: 12px; text-align: center; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Qty</th>' +
    '<th style="padding: 12px; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Price</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #dc2626;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Your Earnings</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + supplierNetEarnings.toFixed(2) + '</td>' +
    '</tr></table></td></tr>' +
    shippingHtml +
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£' + supplierNetEarnings.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Item Price:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + merchTotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + processingFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Fee (5%):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div></td></tr>' +
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order. Once shipped, send tracking info to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div></td></tr>' +
    '<tr><td style="padding-top: 16px;">' +
    '<div style="font-size: 12px; color: #9ca3af;">Customer email: <strong style="color: #fff;">' + order.customer.email + '</strong></div>' +
    '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    '<div style="margin-top: 8px;"><a href="https://freshwax.co.uk" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}
