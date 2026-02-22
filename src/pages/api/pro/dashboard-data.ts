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
      createdAt: r.createdAt || null
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
  const userData = await getDocument('users', userId);
  const sellerDoc = await getDocument('merch-sellers', userId);

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

  // Artist stats
  if (roles.artist) {
    const releases = await queryCollection('releases', {
      filters: [{ field: 'artistId', op: 'EQUAL', value: userId }]
    });
    const sales = await queryCollection('sales', {
      filters: [{ field: 'artistId', op: 'EQUAL', value: userId }]
    });

    let pending = 0;
    (releases || []).forEach((r: Record<string, unknown>) => {
      if (r.status === 'pending') pending++;
    });

    let monthTotal = 0;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    (sales || []).forEach((s: Record<string, unknown>) => {
      const saleDate = s.createdAt ? new Date(s.createdAt) : new Date(0);
      if (saleDate >= startOfMonth) {
        monthTotal += s.amount || s.price || 0;
      }
    });

    result.artist = {
      totalReleases: (releases || []).length,
      pendingReleases: pending,
      totalSales: (sales || []).length,
      monthRevenue: monthTotal
    };
  }

  // Merch stats
  if (roles.merchSeller) {
    const products = await queryCollection('merch', {
      filters: [{ field: 'sellerId', op: 'EQUAL', value: userId }]
    });
    const pendingOrders = await queryCollection('orders', {
      filters: [
        { field: 'sellerId', op: 'EQUAL', value: userId },
        { field: 'status', op: 'EQUAL', value: 'pending' }
      ]
    });

    let lowStock = 0;
    (products || []).forEach((p: Record<string, unknown>) => {
      if ((p.stock || 0) < 5) lowStock++;
    });

    result.merch = {
      totalProducts: (products || []).length,
      lowStock,
      pendingOrders: (pendingOrders || []).length,
      monthRevenue: 0
    };
  }

  return jsonResponse(result);
}
