// src/lib/order/customer.ts
// Customer order tracking updates

import { updateDocument, atomicIncrement } from '../firebase-rest';
import { log } from './types';

// Update customer order count
export async function updateCustomerOrderCount(userId: string): Promise<void> {
  if (!userId) return;

  try {
    await atomicIncrement('users', userId, { orderCount: 1 });
    await updateDocument('users', userId, {
      lastOrderAt: new Date().toISOString()
    });
  } catch (e: unknown) {
    log.error('[order-utils] Error updating customer:', e);
  }
}
