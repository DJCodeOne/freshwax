// src/pages/api/admin/export-analytics.ts
// Export analytics data as CSV

import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'orders';
  const period = parseInt(url.searchParams.get('period') || '30', 10);
  const adminKey = url.searchParams.get('adminKey');

  const env = (locals as any)?.runtime?.env;

  // Simple admin key check for GET requests
  const ADMIN_KEY = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  if (!adminKey || adminKey !== ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);
    const startDateStr = startDate.toISOString();

    let csv = '';
    let filename = '';

    switch (type) {
      case 'orders': {
        const orders = await queryCollection('orders', {
          filters: [{ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDateStr }],
          orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
          limit: 1000
        });

        csv = 'Order Number,Date,Customer Email,Customer Name,Items,Subtotal,Shipping,Service Fees,Total,Status,Payment Method\n';

        for (const order of orders) {
          const items = (order.items || []).map((i: any) => `${i.name} x${i.quantity || 1}`).join('; ');
          const customerName = `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim();

          csv += [
            order.orderNumber || order.id,
            new Date(order.createdAt).toISOString().split('T')[0],
            `"${order.customer?.email || ''}"`,
            `"${customerName}"`,
            `"${items}"`,
            order.totals?.subtotal?.toFixed(2) || '0.00',
            order.totals?.shipping?.toFixed(2) || '0.00',
            order.totals?.serviceFees?.toFixed(2) || '0.00',
            order.totals?.total?.toFixed(2) || '0.00',
            order.status || 'pending',
            order.paymentMethod || 'stripe'
          ].join(',') + '\n';
        }

        filename = `orders-export-${period}days-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      }

      case 'sales': {
        const orders = await queryCollection('orders', {
          filters: [
            { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDateStr },
            { field: 'status', op: 'NOT_EQUAL', value: 'cancelled' }
          ],
          limit: 1000
        });

        // Group by day
        const dailySales: Record<string, { revenue: number; orders: number; units: number }> = {};

        for (const order of orders) {
          const date = new Date(order.createdAt).toISOString().split('T')[0];
          if (!dailySales[date]) {
            dailySales[date] = { revenue: 0, orders: 0, units: 0 };
          }
          dailySales[date].revenue += order.totals?.total || 0;
          dailySales[date].orders++;
          dailySales[date].units += (order.items || []).reduce((sum: number, i: any) => sum + (i.quantity || 1), 0);
        }

        csv = 'Date,Revenue,Orders,Units Sold,Average Order Value\n';

        const sortedDates = Object.keys(dailySales).sort();
        for (const date of sortedDates) {
          const data = dailySales[date];
          csv += [
            date,
            data.revenue.toFixed(2),
            data.orders,
            data.units,
            data.orders > 0 ? (data.revenue / data.orders).toFixed(2) : '0.00'
          ].join(',') + '\n';
        }

        filename = `sales-report-${period}days-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      }

      case 'products': {
        const orders = await queryCollection('orders', {
          filters: [
            { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDateStr },
            { field: 'status', op: 'NOT_EQUAL', value: 'cancelled' }
          ],
          limit: 1000
        });

        const productSales: Record<string, { name: string; units: number; revenue: number; orders: number }> = {};

        for (const order of orders) {
          for (const item of (order.items || [])) {
            const id = item.releaseId || item.productId || item.id || item.name;
            if (!productSales[id]) {
              productSales[id] = { name: item.name, units: 0, revenue: 0, orders: 0 };
            }
            productSales[id].units += item.quantity || 1;
            productSales[id].revenue += (item.price || 0) * (item.quantity || 1);
            productSales[id].orders++;
          }
        }

        csv = 'Product,Units Sold,Revenue,Orders,Average Price\n';

        const sortedProducts = Object.values(productSales).sort((a, b) => b.revenue - a.revenue);
        for (const product of sortedProducts) {
          csv += [
            `"${product.name}"`,
            product.units,
            product.revenue.toFixed(2),
            product.orders,
            product.units > 0 ? (product.revenue / product.units).toFixed(2) : '0.00'
          ].join(',') + '\n';
        }

        filename = `product-sales-${period}days-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      }

      case 'payouts': {
        const payouts = await queryCollection('payouts', {
          filters: [{ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDateStr }],
          orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
          limit: 1000
        });

        csv = 'Date,Artist,Order Number,Amount,Status,Transfer ID\n';

        for (const payout of payouts) {
          csv += [
            new Date(payout.createdAt).toISOString().split('T')[0],
            `"${payout.artistName || ''}"`,
            payout.orderNumber || '',
            payout.amount?.toFixed(2) || '0.00',
            payout.status || 'unknown',
            payout.stripeTransferId || ''
          ].join(',') + '\n';
        }

        filename = `payouts-${period}days-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      }

      case 'refunds': {
        const refunds = await queryCollection('refunds', {
          filters: [{ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDateStr }],
          orderBy: [{ field: 'createdAt', direction: 'DESCENDING' }],
          limit: 500
        });

        csv = 'Date,Order Number,Customer,Amount,Reason,Status\n';

        for (const refund of refunds) {
          csv += [
            new Date(refund.createdAt).toISOString().split('T')[0],
            refund.orderNumber || '',
            `"${refund.customerEmail || ''}"`,
            refund.amount?.toFixed(2) || '0.00',
            refund.reason || '',
            refund.status || 'completed'
          ].join(',') + '\n';
        }

        filename = `refunds-${period}days-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      }

      case 'customers': {
        const orders = await queryCollection('orders', {
          filters: [{ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: startDateStr }],
          limit: 1000
        });

        const customers: Record<string, { email: string; name: string; orders: number; revenue: number; firstOrder: string; lastOrder: string }> = {};

        for (const order of orders) {
          const email = order.customer?.email?.toLowerCase();
          if (!email) continue;

          if (!customers[email]) {
            customers[email] = {
              email,
              name: `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim(),
              orders: 0,
              revenue: 0,
              firstOrder: order.createdAt,
              lastOrder: order.createdAt
            };
          }

          customers[email].orders++;
          customers[email].revenue += order.totals?.total || 0;
          if (order.createdAt < customers[email].firstOrder) customers[email].firstOrder = order.createdAt;
          if (order.createdAt > customers[email].lastOrder) customers[email].lastOrder = order.createdAt;
        }

        csv = 'Email,Name,Total Orders,Total Revenue,First Order,Last Order\n';

        const sortedCustomers = Object.values(customers).sort((a, b) => b.revenue - a.revenue);
        for (const customer of sortedCustomers) {
          csv += [
            `"${customer.email}"`,
            `"${customer.name}"`,
            customer.orders,
            customer.revenue.toFixed(2),
            new Date(customer.firstOrder).toISOString().split('T')[0],
            new Date(customer.lastOrder).toISOString().split('T')[0]
          ].join(',') + '\n';
        }

        filename = `customers-${period}days-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      }

      default:
        return new Response(JSON.stringify({
          error: 'Invalid export type. Valid types: orders, sales, products, payouts, refunds, customers'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });

  } catch (error: any) {
    console.error('[export-analytics] Error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Export failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
