// src/lib/stripe-webhook/credit-deduction.ts
// Deduct applied credit from user's balance after successful order

import { getDocument, updateDocument, atomicIncrement, arrayUnion } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('stripe-webhook-credit-deduction');

/**
 * Deduct applied credit from user's balance after a successful order.
 * Uses atomic operations to prevent race conditions.
 * Non-fatal: failures are logged but don't affect order creation.
 */
export async function deductAppliedCredit(params: {
  appliedCredit: number;
  userId: string;
  orderId: string;
  orderNumber?: string;
}): Promise<void> {
  const { appliedCredit, userId, orderId, orderNumber } = params;

  if (appliedCredit <= 0 || !userId) return;

  try {
    const creditData = await getDocument('userCredits', userId);
    if (creditData && (creditData.balance as number) >= appliedCredit) {
      const now = new Date().toISOString();

      // Atomically decrement balance to prevent race conditions
      await atomicIncrement('userCredits', userId, { balance: -appliedCredit });

      // Create transaction record
      const newBalance = (creditData.balance as number) - appliedCredit;
      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const transaction = {
        id: transactionId,
        type: 'purchase',
        amount: -appliedCredit,
        description: `Applied to order ${orderNumber || orderId}`,
        orderId,
        orderNumber,
        createdAt: now,
        balanceAfter: newBalance
      };

      // Atomic arrayUnion prevents lost transactions under concurrent writes
      await arrayUnion('userCredits', userId, 'transactions', [transaction], {
        lastUpdated: now
      });

      // Also update user document atomically
      await atomicIncrement('users', userId, { creditBalance: -appliedCredit });
      await updateDocument('users', userId, { creditUpdatedAt: now });
    } else {
      log.warn('[credit-deduction] Insufficient credit balance for deduction');
    }
  } catch (creditErr: unknown) {
    log.error('[credit-deduction] Failed to deduct credit:', creditErr);
    // Don't fail the order, just log the error
  }
}
