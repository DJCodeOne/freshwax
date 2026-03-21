// src/lib/d1/ledger.ts
// D1 operations for sales ledger

import type { FirestoreDoc, D1Database, D1Row } from './types';
import { log } from './types';

export interface D1LedgerEntry {
  id: string;
  order_id: string;
  order_number: string;
  timestamp: string;
  year: number;
  month: number;
  day: number;
  customer_id: string | null;
  customer_email: string;
  artist_id: string | null;
  artist_name: string | null;
  submitter_id: string | null;
  submitter_email: string | null;
  subtotal: number;
  shipping: number;
  discount: number;
  gross_total: number;
  stripe_fee: number;
  paypal_fee: number;
  freshwax_fee: number;
  total_fees: number;
  net_revenue: number;
  artist_payout: number;
  artist_payout_status: string;
  payment_method: string;
  payment_id: string | null;
  currency: string;
  item_count: number;
  has_physical: number;
  has_digital: number;
  data: string;
  created_at: string;
  corrected_at: string | null;
}

// Convert ledger entry to D1 row format
export function ledgerToD1Row(entry: FirestoreDoc): Partial<D1LedgerEntry> {
  return {
    id: entry.id,
    order_id: entry.orderId,
    order_number: entry.orderNumber,
    timestamp: entry.timestamp,
    year: entry.year,
    month: entry.month,
    day: entry.day,
    customer_id: entry.customerId || null,
    customer_email: entry.customerEmail,
    artist_id: entry.artistId || null,
    artist_name: entry.artistName || null,
    submitter_id: entry.submitterId || null,
    submitter_email: entry.submitterEmail || null,
    subtotal: entry.subtotal || 0,
    shipping: entry.shipping || 0,
    discount: entry.discount || 0,
    gross_total: entry.grossTotal || 0,
    stripe_fee: entry.stripeFee || 0,
    paypal_fee: entry.paypalFee || 0,
    freshwax_fee: entry.freshWaxFee || 0,
    total_fees: entry.totalFees || 0,
    net_revenue: entry.netRevenue || 0,
    artist_payout: entry.artistPayout || 0,
    artist_payout_status: entry.artistPayoutStatus || 'pending',
    payment_method: entry.paymentMethod || 'stripe',
    payment_id: entry.paymentId || null,
    currency: entry.currency || 'GBP',
    item_count: entry.itemCount || entry.items?.length || 0,
    has_physical: entry.hasPhysical ? 1 : 0,
    has_digital: entry.hasDigital ? 1 : 0,
    data: JSON.stringify(entry),
    corrected_at: entry.correctedAt || null
  };
}

// Convert D1 row to ledger entry format
export function d1RowToLedger(row: D1LedgerEntry): FirestoreDoc | null {
  let doc;
  try {
    doc = JSON.parse(row.data);
  } catch (error: unknown) {
    log.error('[D1] Error parsing ledger data:', error);
    return null;
  }
  doc.id = row.id;
  // Ensure key fields are present
  doc.artistPayoutStatus = row.artist_payout_status;
  doc.artistPayout = row.artist_payout;
  return doc;
}

// Insert a new ledger entry
export async function d1InsertLedgerEntry(db: D1Database, id: string, entry: FirestoreDoc): Promise<boolean> {
  try {
    const row = ledgerToD1Row({ ...entry, id });

    await db.prepare(`
      INSERT INTO sales_ledger (
        id, order_id, order_number, timestamp, year, month, day,
        customer_id, customer_email, artist_id, artist_name, submitter_id, submitter_email,
        subtotal, shipping, discount, gross_total,
        stripe_fee, paypal_fee, freshwax_fee, total_fees, net_revenue,
        artist_payout, artist_payout_status,
        payment_method, payment_id, currency,
        item_count, has_physical, has_digital, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id, row.order_id, row.order_number, row.timestamp, row.year, row.month, row.day,
      row.customer_id, row.customer_email, row.artist_id, row.artist_name, row.submitter_id, row.submitter_email,
      row.subtotal, row.shipping, row.discount, row.gross_total,
      row.stripe_fee, row.paypal_fee, row.freshwax_fee, row.total_fees, row.net_revenue,
      row.artist_payout, row.artist_payout_status,
      row.payment_method, row.payment_id, row.currency,
      row.item_count, row.has_physical, row.has_digital, row.data
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error inserting ledger entry:', error);
    return false;
  }
}

// Update ledger entry (for corrections)
export async function d1UpdateLedgerEntry(db: D1Database, id: string, updates: Record<string, unknown>): Promise<boolean> {
  try {
    // Build update query dynamically based on what fields are provided
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.artistPayoutStatus !== undefined) {
      fields.push('artist_payout_status = ?');
      values.push(updates.artistPayoutStatus);
    }
    if (updates.artistPayout !== undefined) {
      fields.push('artist_payout = ?');
      values.push(updates.artistPayout);
    }
    if (updates.artistId !== undefined) {
      fields.push('artist_id = ?');
      values.push(updates.artistId);
    }
    if (updates.artistName !== undefined) {
      fields.push('artist_name = ?');
      values.push(updates.artistName);
    }
    if (updates.submitterId !== undefined) {
      fields.push('submitter_id = ?');
      values.push(updates.submitterId);
    }
    if (updates.submitterEmail !== undefined) {
      fields.push('submitter_email = ?');
      values.push(updates.submitterEmail);
    }
    if (updates.grossTotal !== undefined) {
      fields.push('gross_total = ?');
      values.push(updates.grossTotal);
    }
    if (updates.netRevenue !== undefined) {
      fields.push('net_revenue = ?');
      values.push(updates.netRevenue);
    }
    if (updates.totalFees !== undefined) {
      fields.push('total_fees = ?');
      values.push(updates.totalFees);
    }

    if (fields.length === 0) {
      return true; // Nothing to update
    }

    fields.push('corrected_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await db.prepare(`
      UPDATE sales_ledger SET ${fields.join(', ')} WHERE id = ?
    `).bind(...values).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error updating ledger entry:', error);
    return false;
  }
}

// Get all ledger entries (with optional filters)
export async function d1GetLedgerEntries(db: D1Database, options: {
  year?: number;
  month?: number;
  artistId?: string;
  payoutStatus?: string;
  limit?: number;
} = {}): Promise<FirestoreDoc[]> {
  try {
    let query = 'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE 1=1';
    const params: unknown[] = [];

    if (options.year) {
      query += ' AND year = ?';
      params.push(options.year);
    }
    if (options.month) {
      query += ' AND month = ?';
      params.push(options.month);
    }
    if (options.artistId) {
      query += ' AND (artist_id = ? OR submitter_id = ?)';
      params.push(options.artistId, options.artistId);
    }
    if (options.payoutStatus) {
      query += ' AND artist_payout_status = ?';
      params.push(options.payoutStatus);
    }

    query += ' ORDER BY timestamp DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = db.prepare(query);
    const { results } = params.length > 0
      ? await stmt.bind(...params).all()
      : await stmt.all();

    return (results || []).map((row) => d1RowToLedger(row as D1LedgerEntry)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting ledger entries:', error);
    return [];
  }
}

// Get ledger entry by ID
export async function d1GetLedgerEntryById(db: D1Database, id: string): Promise<FirestoreDoc | null> {
  try {
    const row = await db.prepare(
      'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE id = ?'
    ).bind(id).first();

    return row ? d1RowToLedger(row as D1LedgerEntry) : null;
  } catch (error: unknown) {
    log.error('[D1] Error getting ledger entry:', error);
    return null;
  }
}

// Get ledger entries by order ID
export async function d1GetLedgerEntriesByOrder(db: D1Database, orderId: string): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE order_id = ? ORDER BY timestamp DESC'
    ).bind(orderId).all();

    return (results || []).map((row) => d1RowToLedger(row as D1LedgerEntry)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting ledger entries by order:', error);
    return [];
  }
}

// Get ledger entries for an artist
export async function d1GetLedgerEntriesByArtist(db: D1Database, artistId: string): Promise<FirestoreDoc[]> {
  try {
    const { results } = await db.prepare(
      'SELECT data, artist_payout_status, artist_payout FROM sales_ledger WHERE artist_id = ? OR submitter_id = ? ORDER BY timestamp DESC'
    ).bind(artistId, artistId).all();

    return (results || []).map((row) => d1RowToLedger(row as D1LedgerEntry)).filter(Boolean) as FirestoreDoc[];
  } catch (error: unknown) {
    log.error('[D1] Error getting ledger entries by artist:', error);
    return [];
  }
}

// Get ledger totals (aggregated)
export async function d1GetLedgerTotals(db: D1Database, options: {
  year?: number;
  month?: number;
  artistId?: string;
} = {}): Promise<{
  orders: number;
  grossRevenue: number;
  netRevenue: number;
  totalFees: number;
  pendingPayouts: number;
  paidPayouts: number;
}> {
  try {
    let query = `
      SELECT
        COUNT(*) as orders,
        COALESCE(SUM(gross_total), 0) as gross_revenue,
        COALESCE(SUM(net_revenue), 0) as net_revenue,
        COALESCE(SUM(total_fees), 0) as total_fees,
        COALESCE(SUM(CASE WHEN artist_payout_status = 'pending' THEN artist_payout ELSE 0 END), 0) as pending_payouts,
        COALESCE(SUM(CASE WHEN artist_payout_status = 'paid' THEN artist_payout ELSE 0 END), 0) as paid_payouts
      FROM sales_ledger WHERE 1=1
    `;
    const params: unknown[] = [];

    if (options.year) {
      query += ' AND year = ?';
      params.push(options.year);
    }
    if (options.month) {
      query += ' AND month = ?';
      params.push(options.month);
    }
    if (options.artistId) {
      query += ' AND (artist_id = ? OR submitter_id = ?)';
      params.push(options.artistId, options.artistId);
    }

    const stmt = db.prepare(query);
    const row = params.length > 0
      ? await stmt.bind(...params).first()
      : await stmt.first();

    const r = row as D1Row | null;
    return {
      orders: (r?.orders as number) || 0,
      grossRevenue: (r?.gross_revenue as number) || 0,
      netRevenue: (r?.net_revenue as number) || 0,
      totalFees: (r?.total_fees as number) || 0,
      pendingPayouts: (r?.pending_payouts as number) || 0,
      paidPayouts: (r?.paid_payouts as number) || 0
    };
  } catch (error: unknown) {
    log.error('[D1] Error getting ledger totals:', error);
    return { orders: 0, grossRevenue: 0, netRevenue: 0, totalFees: 0, pendingPayouts: 0, paidPayouts: 0 };
  }
}

// Delete ledger entry (admin only)
export async function d1DeleteLedgerEntry(db: D1Database, id: string): Promise<boolean> {
  try {
    await db.prepare('DELETE FROM sales_ledger WHERE id = ?').bind(id).run();
    return true;
  } catch (error: unknown) {
    log.error('[D1] Error deleting ledger entry:', error);
    return false;
  }
}
