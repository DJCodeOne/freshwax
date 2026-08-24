// src/lib/payout-settlement.ts
// Settlement engine for MANUAL payout flows (Mark as Paid, admin PayPal
// payouts). The pendingPayouts rows are the single source of truth for who
// is owed what — correct artist uid, exact amount, postage included — so
// settlement must never recompute amounts from order items (item.artistId
// is null on every real order, and fee estimates drift from actuals).
//
// For each payable row this writes the payouts history record FROM the row,
// flips the row to completed, and keeps artists.pendingBalance /
// totalEarnings in sync atomically. The Stripe rail has its own engine with
// identical bookkeeping (lib/stripe-connect-payouts.ts).

import { queryCollection, addDocument, updateDocument, atomicIncrement } from './firebase-rest';
import { createLogger } from './api-utils';

const log = createLogger('[payout-settlement]');

// 'processing' is deliberately NOT payable — a crashed Stripe run may have
// made the transfer before marking the row, and settling it would double-pay.
const PAYABLE_STATUSES = ['pending', 'awaiting_connect', 'retry_pending'];

export interface SettlementParams {
  /** Scope: one order's rows, one artist's rows, or the intersection. At least one required. */
  orderId?: string;
  artistId?: string;
  /** How the partner was actually paid. */
  method: 'manual' | 'paypal';
  notes?: string;
  /** Extra fields stamped onto each payouts record (e.g. paypalBatchId). */
  extra?: Record<string, unknown>;
  triggeredBy?: string;
}

export interface SettlementResult {
  settled: number;
  totalAmount: number;
  skipped: number;
  artists: Array<{ artistId: string; artistName: string; amount: number }>;
}

export async function settlePendingArtistRows(params: SettlementParams): Promise<SettlementResult> {
  const { orderId, artistId, method, notes, extra, triggeredBy = 'admin' } = params;
  if (!orderId && !artistId) throw new Error('settlePendingArtistRows: orderId or artistId required');

  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  if (orderId) filters.push({ field: 'orderId', op: 'EQUAL', value: orderId });
  if (artistId) filters.push({ field: 'artistId', op: 'EQUAL', value: artistId });
  filters.push({ field: 'status', op: 'IN', value: PAYABLE_STATUSES });

  const rows = await queryCollection('pendingPayouts', { filters, limit: 100 });

  const result: SettlementResult = { settled: 0, totalAmount: 0, skipped: 0, artists: [] };

  for (const row of rows) {
    const rowArtistId = row.artistId as string | undefined;
    const amount = Number(row.amount) || 0;
    if (!rowArtistId || amount <= 0) {
      result.skipped += 1;
      log.warn(`Skipping unsettleable pendingPayouts row ${row.id} (artistId=${rowArtistId}, amount=${amount})`);
      continue;
    }

    const now = new Date().toISOString();

    // History record built FROM the row — ids and amounts stay exact.
    await addDocument('payouts', {
      artistId: rowArtistId,
      artistName: row.artistName || '',
      artistEmail: row.artistEmail || '',
      entityType: 'artist',
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      amount,
      itemAmount: row.itemAmount ?? amount,
      shippingAmount: row.shippingAmount || 0,
      currency: row.currency || 'gbp',
      status: 'completed',
      payoutMethod: method,
      triggeredBy,
      notes: notes || '',
      fromPendingPayout: row.id,
      ...(extra || {}),
      createdAt: now,
      updatedAt: now,
      completedAt: now
    });

    await updateDocument('pendingPayouts', row.id, {
      status: 'completed',
      payoutMethod: method,
      completedBy: triggeredBy,
      completedAt: now,
      updatedAt: now,
      ...(notes ? { notes } : {})
    });

    try {
      await atomicIncrement('artists', rowArtistId, {
        pendingBalance: -amount,
        totalEarnings: amount,
      });
      await updateDocument('artists', rowArtistId, { lastPayoutAt: now, updatedAt: now });
    } catch (balanceError: unknown) {
      log.warn(`Balance sync failed for ${rowArtistId} after settling row ${row.id}`, balanceError);
    }

    result.settled += 1;
    result.totalAmount += amount;
    result.artists.push({ artistId: rowArtistId, artistName: String(row.artistName || rowArtistId), amount });
  }

  return result;
}
