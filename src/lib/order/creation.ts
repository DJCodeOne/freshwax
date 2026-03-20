// src/lib/order/creation.ts
// Main order creation orchestration

import { addDocument } from '../firebase-rest';
import { log } from './types';
import type { CartItem } from './types';
import { generateOrderNumber } from './utils';
import { processItemsWithDownloads } from './stock-validation';
import { updateVinylStock, processVinylCratesOrders } from './vinyl-processing';
import { updateMerchStock } from './merch-processing';
import { sendOrderConfirmationEmail, sendVinylFulfillmentEmail, sendDigitalSaleEmails, sendMerchSaleEmails } from './emails';
import { updateCustomerOrderCount } from './customer';

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
    items: CartItem[];
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
  env: Record<string, unknown>;
  idToken?: string;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  orderNumber?: string;
  error?: string;
}

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const { orderData, env, idToken } = params;
  const now = new Date().toISOString();
  const orderNumber = generateOrderNumber();

  try {
    // Process items with download URLs
    const itemsWithDownloads = await processItemsWithDownloads(orderData.items);

    // Check for pre-orders
    const hasPreOrderItems = itemsWithDownloads.some((item: CartItem) => item.isPreOrder === true);
    const preOrderReleaseDates = itemsWithDownloads
      .filter((item: CartItem) => item.isPreOrder && item.releaseDate)
      .map((item: CartItem) => new Date(item.releaseDate as string));
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
    const orderRef = await addDocument('orders', order, idToken);
    log.info('[createOrder] Order created:', orderNumber, orderRef.id);

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
    await sendOrderConfirmationEmail(order, orderRef.id, orderNumber, env);

    // Send vinyl fulfillment email if applicable
    const vinylItems = order.items.filter((item: CartItem) => item.type === 'vinyl');
    if (vinylItems.length > 0) {
      await sendVinylFulfillmentEmail(order, orderRef.id, orderNumber, vinylItems, env);
    }

    // Send digital sale emails
    const digitalItems = order.items.filter((item: CartItem) =>
      item.type === 'track' || item.type === 'digital' || item.type === 'release'
    );
    if (digitalItems.length > 0) {
      await sendDigitalSaleEmails(order, orderNumber, digitalItems, env);
    }

    // Send merch sale emails
    const merchItems = order.items.filter((item: CartItem) => item.type === 'merch');
    if (merchItems.length > 0) {
      await sendMerchSaleEmails(order, orderNumber, merchItems, env);
    }

    // Update customer order count
    if (orderData.customer.userId) {
      await updateCustomerOrderCount(orderData.customer.userId);
    }

    return {
      success: true,
      orderId: orderRef.id,
      orderNumber
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[createOrder] ❌ ERROR:', errorMessage);
    log.error('[createOrder] Stack:', error instanceof Error ? error.stack : 'no stack');
    return {
      success: false,
      error: errorMessage
    };
  }
}
