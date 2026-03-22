// src/lib/order/emails/index.ts
// Barrel re-export — all existing imports from './create-order-emails' continue working

export { buildOrderConfirmationEmail } from './buyer-email';
export { buildStockistFulfillmentEmail } from './vinyl-email';
export { buildDigitalSaleEmail } from './seller-email';
export { buildMerchSaleEmail } from './merch-email';
export type { OrderItem } from './types';
