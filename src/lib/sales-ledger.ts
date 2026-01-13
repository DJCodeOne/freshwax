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

  // Artist/Submitter (for payout tracking)
  artistId?: string | null;       // User ID of the artist to be paid
  artistName?: string | null;     // Display name
  submitterId?: string | null;    // User ID who submitted (usually same as artistId)
  submitterEmail?: string | null; // Email for payout notifications

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
  // Artist/submitter info for payout tracking
  artistId?: string | null;
  artistName?: string | null;
  submitterId?: string | null;
  submitterEmail?: string | null;
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

    // Calculate artist payout (net revenue after all fees)
    const artistPayout = netRevenue;

    const entry: LedgerEntry & { artistPayout?: number; artistPayoutStatus?: string } = {
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      timestamp: now.toISOString(),
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      customerId: params.customerId || null,
      customerEmail: params.customerEmail,
      // Artist/submitter info
      artistId: params.artistId || null,
      artistName: params.artistName || null,
      submitterId: params.submitterId || null,
      submitterEmail: params.submitterEmail || null,
      // Revenue
      subtotal: params.subtotal,
      shipping: params.shipping || 0,
      discount: params.discount || 0,
      grossTotal: params.grossTotal,
      stripeFee,
      paypalFee,
      freshWaxFee,
      totalFees,
      netRevenue,
      // Artist payout tracking
      artistPayout,
      artistPayoutStatus: 'pending',
      // Payment info
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
 * Record a multi-seller order to the sales ledger
 * Creates separate ledger entries for each seller/artist
 */
export async function recordMultiSellerSale(params: {
  orderId: string;
  orderNumber: string;
  customerId?: string | null;
  customerEmail: string;
  grossTotal: number;
  shipping?: number;
  stripeFee?: number;
  paypalFee?: number;
  freshWaxFee?: number;
  paymentMethod: LedgerEntry['paymentMethod'];
  paymentId?: string | null;
  currency?: string;
  hasPhysical?: boolean;
  hasDigital?: boolean;
  // Items with seller info - each item should have submitterId from release lookup
  items: Array<{
    id?: string;
    releaseId?: string;
    productId?: string;
    name?: string;
    title?: string;
    type?: string;
    price: number;
    quantity?: number;
    artist?: string;
    artistName?: string;
    submitterId?: string | null;
    submitterEmail?: string | null;
  }>;
}): Promise<{ success: boolean; ledgerIds?: string[]; error?: string }> {
  try {
    const now = new Date();
    const ledgerIds: string[] = [];

    // Group items by seller (submitterId)
    const sellerGroups: Map<string, typeof params.items> = new Map();
    const unknownSellerItems: typeof params.items = [];

    for (const item of params.items) {
      const sellerId = item.submitterId;
      if (sellerId) {
        if (!sellerGroups.has(sellerId)) {
          sellerGroups.set(sellerId, []);
        }
        sellerGroups.get(sellerId)!.push(item);
      } else {
        unknownSellerItems.push(item);
      }
    }

    // Calculate order totals for proportional fee distribution
    const orderSubtotal = params.items.reduce((sum, item) =>
      sum + (item.price * (item.quantity || 1)), 0);
    const totalFees = (params.stripeFee || 0) + (params.paypalFee || 0) + (params.freshWaxFee || 0);

    // Create ledger entry for each seller
    for (const [sellerId, sellerItems] of sellerGroups) {
      // Calculate this seller's portion
      const sellerSubtotal = sellerItems.reduce((sum, item) =>
        sum + (item.price * (item.quantity || 1)), 0);
      const sellerProportion = orderSubtotal > 0 ? sellerSubtotal / orderSubtotal : 0;

      // Proportional fees
      const sellerStripeFee = (params.stripeFee || 0) * sellerProportion;
      const sellerPaypalFee = (params.paypalFee || 0) * sellerProportion;
      const sellerFreshWaxFee = (params.freshWaxFee || 0) * sellerProportion;
      const sellerTotalFees = sellerStripeFee + sellerPaypalFee + sellerFreshWaxFee;
      const sellerNetRevenue = sellerSubtotal - sellerTotalFees;

      // Get seller info from first item
      const firstItem = sellerItems[0];
      const artistName = firstItem.artist || firstItem.artistName || null;
      const submitterEmail = firstItem.submitterEmail || null;

      // Process items for summary
      const itemsSummary = sellerItems.map(item => {
        const type = item.type === 'merch' ? 'merch' :
                     item.type === 'vinyl' ? 'vinyl' :
                     item.type === 'track' ? 'track' :
                     item.type === 'release' || item.type === 'digital' || item.releaseId ? 'release' : 'other';
        return {
          type: type as 'release' | 'track' | 'merch' | 'vinyl' | 'other',
          id: item.releaseId || item.productId || item.id || '',
          title: item.title || item.name || 'Unknown',
          artist: item.artist || item.artistName || undefined,
          quantity: item.quantity || 1,
          unitPrice: item.price || 0,
          lineTotal: (item.price || 0) * (item.quantity || 1)
        };
      });

      const entry: LedgerEntry & { artistPayout: number; artistPayoutStatus: string } = {
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        timestamp: now.toISOString(),
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        customerId: params.customerId || null,
        customerEmail: params.customerEmail,
        // Seller info
        artistId: sellerId,
        artistName: artistName,
        submitterId: sellerId,
        submitterEmail: submitterEmail,
        // Revenue (this seller's portion)
        subtotal: sellerSubtotal,
        shipping: 0, // Shipping handled separately or by platform
        discount: 0,
        grossTotal: sellerSubtotal, // Seller's gross is their item total
        stripeFee: Math.round(sellerStripeFee * 100) / 100,
        paypalFee: Math.round(sellerPaypalFee * 100) / 100,
        freshWaxFee: Math.round(sellerFreshWaxFee * 100) / 100,
        totalFees: Math.round(sellerTotalFees * 100) / 100,
        netRevenue: Math.round(sellerNetRevenue * 100) / 100,
        // Artist payout
        artistPayout: Math.round(sellerNetRevenue * 100) / 100,
        artistPayoutStatus: 'pending',
        // Payment info
        paymentMethod: params.paymentMethod,
        paymentId: params.paymentId || null,
        currency: params.currency || 'GBP',
        itemCount: itemsSummary.length,
        hasPhysical: itemsSummary.some(i => i.type === 'merch' || i.type === 'vinyl'),
        hasDigital: itemsSummary.some(i => i.type === 'release' || i.type === 'track'),
        items: itemsSummary
      };

      const result = await addDocument('salesLedger', entry);
      ledgerIds.push(result.id);
      console.log(`[sales-ledger] Recorded sale for seller ${sellerId}: ${params.orderNumber} - £${sellerSubtotal.toFixed(2)} (net: £${sellerNetRevenue.toFixed(2)})`);
    }

    // Handle items with unknown seller (platform keeps this revenue)
    if (unknownSellerItems.length > 0) {
      const unknownSubtotal = unknownSellerItems.reduce((sum, item) =>
        sum + (item.price * (item.quantity || 1)), 0);
      console.log(`[sales-ledger] ${unknownSellerItems.length} items with unknown seller (£${unknownSubtotal.toFixed(2)}) - platform revenue`);
    }

    return { success: true, ledgerIds };
  } catch (error) {
    console.error('[sales-ledger] Error recording multi-seller sale:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
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
