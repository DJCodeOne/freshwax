// src/lib/order-utils.ts
// Barrel re-export — all order utilities split into focused modules under ./order/
// This file preserves backward compatibility for all existing importers.

// Types (use `export type` for interfaces — critical for Rollup/Vite builds)
export type { CartItem, VariantStockEntry } from './order/types';

// Order number utilities
export { generateOrderNumber, getShortOrderNumber } from './order/utils';

// Stock reservation system
export { reserveStock, releaseReservation, convertReservation, cleanupExpiredReservations } from './order/stock-reservation';

// Stock validation and price verification
export { validateStock, validateAndGetPrices, processItemsWithDownloads } from './order/stock-validation';

// Vinyl stock updates and crates processing
export { updateVinylStock, processVinylCratesOrders } from './order/vinyl-processing';

// Merch stock updates
export { updateMerchStock } from './order/merch-processing';

// Refund logic
export { refundOrderStock } from './order/refund';

// Email sending
export { sendOrderConfirmationEmail, sendVinylFulfillmentEmail, sendDigitalSaleEmails, sendMerchSaleEmails } from './order/emails';

// Customer tracking
export { updateCustomerOrderCount } from './order/customer';

// Order creation (main orchestrator)
export type { CreateOrderParams, CreateOrderResult } from './order/creation';
export { createOrder } from './order/creation';
