// src/lib/d1/royalties.ts
// D1 operations for royalty ledger

import type { D1Database } from './types';
import { log } from './types';

export interface RoyaltyEntry {
  id: string;
  orderId: string;
  brandAccountId?: string;
  brandName: string;
  itemId: string;
  itemName: string;
  quantity: number;
  saleTotal: number;
  royaltyPct: number;
  royaltyAmount: number;
  freshwaxAmount: number;
  status?: string;
}

export async function d1RecordRoyalty(db: D1Database, entry: RoyaltyEntry): Promise<boolean> {
  try {
    await db.prepare(
      `INSERT INTO royalty_ledger (id, order_id, brand_account_id, brand_name, item_id, item_name, quantity, sale_total, royalty_pct, royalty_amount, freshwax_amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
    ).bind(
      entry.id,
      entry.orderId,
      entry.brandAccountId || null,
      entry.brandName,
      entry.itemId,
      entry.itemName,
      entry.quantity,
      entry.saleTotal,
      entry.royaltyPct,
      entry.royaltyAmount,
      entry.freshwaxAmount
    ).run();
    return true;
  } catch (error: unknown) {
    log.error('[D1] Error recording royalty:', error);
    return false;
  }
}

export async function d1GetRoyaltyLedger(db: D1Database, options?: {
  brandName?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ entries: Record<string, unknown>[]; totalPending: number; totalPaid: number }> {
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.brandName) {
      conditions.push('brand_name = ?');
      params.push(options.brandName);
    }
    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = options?.limit || 200;
    const offset = options?.offset || 0;

    const { results } = await db.prepare(
      `SELECT id, order_id, brand_account_id, brand_name, item_id, item_name, quantity, sale_total, royalty_pct, royalty_amount, freshwax_amount, status, paid_at, created_at
       FROM royalty_ledger ${whereClause}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    // Get totals
    const totalsResult = await db.prepare(
      `SELECT status, SUM(royalty_amount) as total FROM royalty_ledger GROUP BY status`
    ).all();

    let totalPending = 0;
    let totalPaid = 0;
    for (const row of (totalsResult.results || [])) {
      if ((row as Record<string, unknown>).status === 'pending') totalPending = (row as Record<string, unknown>).total as number || 0;
      if ((row as Record<string, unknown>).status === 'paid') totalPaid = (row as Record<string, unknown>).total as number || 0;
    }

    return {
      entries: (results || []) as Record<string, unknown>[],
      totalPending,
      totalPaid
    };
  } catch (error: unknown) {
    log.error('[D1] Error getting royalty ledger:', error);
    return { entries: [], totalPending: 0, totalPaid: 0 };
  }
}

export async function d1MarkRoyaltiesPaid(db: D1Database, ids: string[]): Promise<number> {
  try {
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(',');
    const result = await db.prepare(
      `UPDATE royalty_ledger SET status = 'paid', paid_at = datetime('now') WHERE id IN (${placeholders}) AND status = 'pending'`
    ).bind(...ids).run();

    return (result as Record<string, unknown>)?.changes as number || ids.length;
  } catch (error: unknown) {
    log.error('[D1] Error marking royalties paid:', error);
    return 0;
  }
}
