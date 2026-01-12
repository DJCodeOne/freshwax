// src/lib/sales-ledger.ts
// Sales ledger for accurate revenue tracking
// Each completed order creates an immutable ledger entry

import { addDocument, queryCollection } from './firebase-rest';

export interface LedgerEntry {
  // Order reference
  orderId: string;
  orderNumber: string;

  // Timing
  timestamp: string;  // ISO string when payment completed
  year: number;
  month: number;  // 1-12
  day: number;

  // Customer
  customerId: string | null;
  customerEmail: string;

  // Revenue breakdown
  subtotal: number;      // Product/item total before fees
  shipping: number;      // Shipping cost
  discount: number;      // Any discounts applied
  grossTotal: number;    // What customer paid (subtotal + shipping - discount)

  // Fees breakdown
  stripeFee: number;     // Stripe processing fee
  paypalFee: number;     // PayPal processing fee
  freshWaxFee: number;   // Platform fee
  totalFees: number;     // Sum of all fees

  // Net revenue
  netRevenue: number;    // grossTotal - totalFees

  // Payment info
  paymentMethod: 'stripe' | 'paypal' | 'free' | 'giftcard' | 'manual';
  paymentId: string | null;  // Stripe payment intent ID or PayPal order ID
  currency: string;

  // Order details
  itemCount: number;
  hasPhysical: boolean;
  hasDigital: boolean;

  // Items summary (for top sellers)
  items: {
    type: 'release' | 'track' | 'merch' | 'vinyl' | 'other';
    id: string;
    title: string;
    artist?: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
}

/**
 * Record a completed order to the sales ledger
 * Call this when payment is confirmed (webhook, capture, etc.)
 */
export async function recordSale(params: {
  orderId: string;
  orderNumber: string;
  customerId?: string | null;
  customerEmail: string;
  subtotal: number;
  shipping?: number;
  discount?: number;
  grossTotal: number;
  stripeFee?: number;
  paypalFee?: number;
  freshWaxFee?: number;
  paymentMethod: LedgerEntry['paymentMethod'];
  paymentId?: string | null;
  currency?: string;
  items: any[];
  hasPhysical?: boolean;
  hasDigital?: boolean;
}): Promise<{ success: boolean; ledgerId?: string; error?: string }> {
  try {
    const now = new Date();

    // Calculate fees
    const stripeFee = params.stripeFee || 0;
    const paypalFee = params.paypalFee || 0;
    const freshWaxFee = params.freshWaxFee || 0;
    const totalFees = stripeFee + paypalFee + freshWaxFee;

    // Calculate net revenue
    const netRevenue = params.grossTotal - totalFees;

    // Process items for summary
    const itemsSummary = (params.items || []).map(item => {
      const type = item.type === 'merch' || item.isPhysical ? 'merch' :
                   item.type === 'vinyl' ? 'vinyl' :
                   item.type === 'track' ? 'track' :
                   item.type === 'release' || item.type === 'digital' || item.releaseId ? 'release' : 'other';

      return {
        type,
        id: item.releaseId || item.productId || item.id || '',
        title: item.title || item.name || 'Unknown',
        artist: item.artist || item.artistName || undefined,
        quantity: item.quantity || 1,
        unitPrice: item.price || 0,
        lineTotal: (item.price || 0) * (item.quantity || 1)
      };
    });

    const entry: LedgerEntry = {
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      timestamp: now.toISOString(),
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      customerId: params.customerId || null,
      customerEmail: params.customerEmail,
      subtotal: params.subtotal,
      shipping: params.shipping || 0,
      discount: params.discount || 0,
      grossTotal: params.grossTotal,
      stripeFee,
      paypalFee,
      freshWaxFee,
      totalFees,
      netRevenue,
      paymentMethod: params.paymentMethod,
      paymentId: params.paymentId || null,
      currency: params.currency || 'GBP',
      itemCount: itemsSummary.length,
      hasPhysical: params.hasPhysical || itemsSummary.some(i => i.type === 'merch' || i.type === 'vinyl'),
      hasDigital: params.hasDigital || itemsSummary.some(i => i.type === 'release' || i.type === 'track'),
      items: itemsSummary
    };

    // Save to ledger collection
    const result = await addDocument('salesLedger', entry);

    console.log(`[sales-ledger] Recorded sale: ${params.orderNumber} - £${params.grossTotal.toFixed(2)}`);

    return { success: true, ledgerId: result.id };
  } catch (error) {
    console.error('[sales-ledger] Error recording sale:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get ledger entries for a date range
 */
export async function getLedgerEntries(options: {
  startDate?: Date;
  endDate?: Date;
  year?: number;
  month?: number;
  limit?: number;
}): Promise<LedgerEntry[]> {
  try {
    const filters: any[] = [];

    if (options.year) {
      filters.push({ field: 'year', op: 'EQUAL', value: options.year });
    }
    if (options.month) {
      filters.push({ field: 'month', op: 'EQUAL', value: options.month });
    }

    const entries = await queryCollection('salesLedger', {
      filters: filters.length > 0 ? filters : undefined,
      orderBy: { field: 'timestamp', direction: 'DESCENDING' },
      limit: options.limit || 1000
    });

    // Filter by date range if provided
    let filtered = entries;
    if (options.startDate || options.endDate) {
      filtered = entries.filter((e: any) => {
        const timestamp = new Date(e.timestamp);
        if (options.startDate && timestamp < options.startDate) return false;
        if (options.endDate && timestamp > options.endDate) return false;
        return true;
      });
    }

    return filtered as LedgerEntry[];
  } catch (error) {
    console.error('[sales-ledger] Error fetching entries:', error);
    return [];
  }
}

/**
 * Calculate totals from ledger entries
 */
export function calculateLedgerTotals(entries: LedgerEntry[]) {
  return entries.reduce((acc, entry) => ({
    orders: acc.orders + 1,
    grossRevenue: acc.grossRevenue + entry.grossTotal,
    netRevenue: acc.netRevenue + entry.netRevenue,
    subtotal: acc.subtotal + entry.subtotal,
    shipping: acc.shipping + entry.shipping,
    discount: acc.discount + entry.discount,
    stripeFees: acc.stripeFees + entry.stripeFee,
    paypalFees: acc.paypalFees + entry.paypalFee,
    freshWaxFees: acc.freshWaxFees + entry.freshWaxFee,
    totalFees: acc.totalFees + entry.totalFees,
    itemCount: acc.itemCount + entry.itemCount
  }), {
    orders: 0,
    grossRevenue: 0,
    netRevenue: 0,
    subtotal: 0,
    shipping: 0,
    discount: 0,
    stripeFees: 0,
    paypalFees: 0,
    freshWaxFees: 0,
    totalFees: 0,
    itemCount: 0
  });
}
