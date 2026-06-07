// src/pages/api/pro/dashboard-data.ts
// Unified data endpoint for Pro Dashboard pages
// Replaces client-side Firestore collection queries (releases, merch, orders, sales)
// GET ?type=releases|merch|orders|stock|analytics|account|overview
import type { APIRoute } from 'astro';
import { getDocument, queryCollection, verifyRequestUser } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger, jsonResponse } from '../../../lib/api-utils';

const log = createLogger('pro/dashboard-data');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`pro-dashboard:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'overview';

    switch (type) {
      case 'releases':
        return await handleReleases(userId);
      case 'merch':
        return await handleMerch(userId);
      case 'orders':
        return await handleOrders(userId);
      case 'vinylOrders':
        return await handleVinylOrders(userId);
      case 'stock':
        return await handleStock(userId);
      case 'analytics':
        return await handleAnalytics(userId, url.searchParams);
      case 'account':
        return await handleAccount(userId);
      case 'overview':
        return await handleOverview(userId);
      default:
        return jsonResponse({ success: false, error: 'Invalid type' }, 400);
    }
  } catch (error: unknown) {
    log.error('[pro/dashboard-data] Error:', error instanceof Error ? error.message : String(error));
    return jsonResponse({ success: false, error: 'Internal error' }, 500);
  }
};


async function handleReleases(userId: string) {
  const releases = await queryCollection('releases', {
    filters: [{ field: 'artistId', op: 'EQUAL', value: userId }],
    orderBy: { field: 'createdAt', direction: 'DESCENDING' }
  });

  return jsonResponse({
    success: true,
    releases: (releases || []).map((r: Record<string, unknown>) => ({
      id: r.id || r._id,
      title: r.title || 'Untitled',
      artistName: r.artistName || 'Unknown Artist',
      artwork: r.artwork || null,
      status: r.status || 'draft',
      trackCount: r.trackCount || 0,
      salesCount: r.salesCount || 0,
      plays: r.plays || 0,
      createdAt: r.createdAt || null,
      // Vinyl shipping fields — used by /pro/releases/ to render the per-release
      // shipping editor. `null` means "no per-release override; cart will fall
      // back to artist-account defaults then hardcoded values".
      vinylRelease: r.vinylRelease === true,
      vinylShippingUK: r.vinylShippingUK ?? null,
      vinylShippingEU: r.vinylShippingEU ?? null,
      vinylShippingIntl: r.vinylShippingIntl ?? null,
    }))
  });
}

async function handleMerch(userId: string) {
  const products = await queryCollection('merch', {
    filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }]
  });

  return jsonResponse({
    success: true,
    products: (products || []).map((p: Record<string, unknown>) => ({
      id: p.id || p._id,
      name: p.name || 'Unnamed Product',
      category: p.category || 'Merchandise',
      image: p.image || null,
      price: p.price || 0,
      stock: p.stock || 0
    }))
  });
}

async function handleOrders(userId: string) {
  const orders = await queryCollection('orders', {
    filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }],
    orderBy: { field: 'createdAt', direction: 'DESCENDING' }
  });

  return jsonResponse({
    success: true,
    orders: (orders || []).map((o: Record<string, unknown>) => ({
      id: o.id || o._id,
      status: o.status || 'pending',
      total: o.total || 0,
      items: o.items || [],
      createdAt: o.createdAt || null,
      customerName: o.customerName || o.shippingAddress?.name || 'Customer',
      customerEmail: o.customerEmail || ''
    }))
  });
}

// List vinyl-release orders that this artist needs to fulfill.
//
// Music releases don't carry a top-level sellerId on the order doc (that field
// is merch-only). The artist link lives in items[].artistId, which Firestore
// can't query directly on a nested array. We use salesLedger as the index:
// entries are written per-seller with artistId, and hasPhysical=true marks any
// order that included a physical item from this artist. We hydrate each unique
// orderId from the orders collection to get the shipping address and tracking
// state, then filter the items array to only those belonging to this artist.
async function handleVinylOrders(userId: string) {
  const ledger = await queryCollection('salesLedger', {
    filters: [
      { field: 'artistId', op: 'EQUAL', value: userId },
      { field: 'hasPhysical', op: 'EQUAL', value: true },
    ],
    orderBy: { field: 'timestamp', direction: 'DESCENDING' },
  });

  const seen = new Set<string>();
  const orderIds: string[] = [];
  for (const entry of (ledger || []) as Record<string, unknown>[]) {
    const oid = entry.orderId as string | undefined;
    if (oid && !seen.has(oid)) { seen.add(oid); orderIds.push(oid); }
  }

  const orderDocs = await Promise.all(orderIds.map(id => getDocument('orders', id).catch(() => null)));

  const orders = orderDocs
    .filter((o): o is Record<string, unknown> => !!o)
    .map(order => {
      const allItems = (order.items as Record<string, unknown>[]) || [];
      // Only show items that belong to this artist and are vinyl/physical.
      const myItems = allItems.filter(it => {
        const matchesArtist = it.artistId === userId;
        const isPhysical = it.type === 'vinyl' || it.format === 'vinyl' || it.type === 'merch';
        return matchesArtist && isPhysical;
      });
      if (myItems.length === 0) return null;

      const tracking = (order.tracking as Record<string, unknown>) || {};
      const customer = (order.customer as Record<string, unknown>) || {};
      const shipping = (order.shipping as Record<string, unknown>) || {};

      return {
        id: order.id || (order as { _id?: string })._id,
        orderNumber: order.orderNumber || null,
        status: order.status || (tracking.trackingNumber ? 'shipped' : 'pending'),
        items: myItems.map(it => ({
          name: it.name || it.title || 'Unnamed',
          quantity: it.quantity || 1,
          price: it.price || 0,
          format: it.format || it.type || 'vinyl',
        })),
        shippingFeePaid: myItems.reduce((acc, it) => acc + ((it.vinylShippingUK as number) || (it.shippingFee as number) || 0), 0),
        customer: {
          name: customer.firstName ? `${customer.firstName} ${customer.lastName || ''}`.trim() : (shipping.name as string) || 'Customer',
          email: customer.email || null,
        },
        shipping: {
          name: shipping.name || null,
          line1: shipping.line1 || shipping.address1 || null,
          line2: shipping.line2 || shipping.address2 || null,
          city: shipping.city || null,
          state: shipping.state || null,
          postalCode: shipping.postalCode || shipping.zip || null,
          country: shipping.country || null,
        },
        tracking: {
          courier: tracking.courier || null,
          trackingNumber: tracking.trackingNumber || null,
          trackingUrl: tracking.trackingUrl || null,
          shippedAt: tracking.addedAt || tracking.shippedAt || null,
        },
        createdAt: order.createdAt || null,
        paymentStatus: order.paymentStatus || null,
      };
    })
    .filter(Boolean);

  return jsonResponse({ success: true, orders });
}

async function handleStock(userId: string) {
  const products = await queryCollection('merch', {
    filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }]
  });

  return jsonResponse({
    success: true,
    products: (products || []).map((p: Record<string, unknown>) => ({
      id: p.id || p._id,
      name: p.name || 'Unnamed',
      sku: p.sku || null,
      category: p.category || null,
      image: p.image || null,
      price: p.price || 0,
      stock: p.stock || 0
    }))
  });
}

async function handleAnalytics(userId: string, params: URLSearchParams) {
  const period = parseInt(params.get('period') || '30');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - period);

  // Get orders for the period
  const orders = await queryCollection('orders', {
    filters: [
      { field: 'sellerId', op: 'EQUAL', value: userId },
      { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDate.toISOString() }
    ],
    orderBy: { field: 'createdAt', direction: 'DESCENDING' }
  });

  let totalRevenue = 0;
  let totalOrders = 0;
  let totalUnits = 0;
  const productSales: Record<string, { units: number; revenue: number }> = {};
  const dailySales: Record<string, { revenue: number; orders: number }> = {};
  const recentSales: Record<string, unknown>[] = [];

  (orders || []).forEach((order: Record<string, unknown>) => {
    totalOrders++;
    totalRevenue += order.total || 0;

    const orderDate = order.createdAt ? new Date(order.createdAt) : new Date();
    const dateKey = orderDate.toISOString().split('T')[0];
    if (!dailySales[dateKey]) {
      dailySales[dateKey] = { revenue: 0, orders: 0 };
    }
    dailySales[dateKey].revenue += order.total || 0;
    dailySales[dateKey].orders++;

    ((order.items as Record<string, unknown>[]) || []).forEach((item: Record<string, unknown>) => {
      const qty = item.quantity || 1;
      totalUnits += qty;

      if (!productSales[item.name]) {
        productSales[item.name] = { units: 0, revenue: 0 };
      }
      productSales[item.name].units += qty;
      productSales[item.name].revenue += (item.price || 0) * qty;

      recentSales.push({
        date: orderDate.toISOString(),
        product: item.name,
        quantity: qty,
        revenue: (item.price || 0) * qty
      });
    });
  });

  return jsonResponse({
    success: true,
    totalRevenue,
    totalOrders,
    totalUnits,
    productSales,
    dailySales,
    recentSales: recentSales.slice(0, 50)
  });
}

async function handleAccount(userId: string) {
  const [userData, sellerDoc] = await Promise.all([
    getDocument('users', userId),
    getDocument('merch-sellers', userId),
  ]);

  return jsonResponse({
    success: true,
    businessName: userData?.pendingRoles?.merchSeller?.businessName || userData?.displayName || 'Not set',
    email: userData?.email || '',
    isMerchSeller: userData?.roles?.merchSeller || false,
    createdAt: userData?.createdAt || null,
    balance: sellerDoc?.balance || 0,
    pendingBalance: sellerDoc?.pendingBalance || 0,
    commissionRate: sellerDoc?.commissionRate || 15
  });
}

async function handleOverview(userId: string) {
  const userData = await getDocument('users', userId);
  const roles = userData?.roles || {};

  const result: Record<string, unknown> = { success: true, roles };

  // Fetch artist + merch stats in parallel where possible
  const artistPromise = roles.artist ? (async () => {
    // Releases and sales queries are independent — run in parallel
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [releases, sales] = await Promise.all([
      queryCollection('releases', {
        filters: [{ field: 'artistId', op: 'EQUAL', value: userId }]
      }),
      // salesLedger is where the Stripe webhook writes per-seller entries
      // (recordMultiSellerSale in src/lib/sales-ledger.ts). The entries use
      // `timestamp` rather than `createdAt`, and the artist's actual take-home
      // for the period is `artistPayout` (grossTotal minus fees + platform cut).
      queryCollection('salesLedger', {
        filters: [
          { field: 'artistId', op: 'EQUAL', value: userId },
          { field: 'timestamp', op: 'GREATER_THAN_OR_EQUAL', value: startOfMonth.toISOString() }
        ],
        orderBy: { field: 'timestamp', direction: 'DESCENDING' }
      })
    ]);

    let pending = 0;
    (releases || []).forEach((r: Record<string, unknown>) => {
      if (r.status === 'pending') pending++;
    });

    let monthTotal = 0;
    (sales || []).forEach((s: Record<string, unknown>) => {
      const payout = (s.artistPayout as number) || (s.amount as number) || (s.price as number) || 0;
      monthTotal += payout;
    });

    return {
      totalReleases: (releases || []).length,
      pendingReleases: pending,
      totalSales: (sales || []).length,
      monthRevenue: monthTotal
    };
  })() : null;

  const merchPromise = roles.merchSeller ? (async () => {
    // Products and pending orders queries are independent — run in parallel
    const [products, pendingOrders] = await Promise.all([
      queryCollection('merch', {
        filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }]
      }),
      queryCollection('orders', {
        filters: [
          { field: 'sellerId', op: 'EQUAL', value: userId },
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ]
      })
    ]);

    let lowStock = 0;
    (products || []).forEach((p: Record<string, unknown>) => {
      if ((p.stock || 0) < 5) lowStock++;
    });

    return {
      totalProducts: (products || []).length,
      lowStock,
      pendingOrders: (pendingOrders || []).length,
      monthRevenue: 0
    };
  })() : null;

  // Await both stat blocks in parallel (artist + merch are fully independent)
  const [artistStats, merchStats] = await Promise.all([artistPromise, merchPromise]);
  if (artistStats) result.artist = artistStats;
  if (merchStats) result.merch = merchStats;

  return jsonResponse(result);
}
