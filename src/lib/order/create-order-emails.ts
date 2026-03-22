// src/lib/order/create-order-emails.ts
// Barrel re-export — preserves existing import paths
// Actual implementations split into emails/ directory

export { buildOrderConfirmationEmail } from './emails/buyer-email';
export { buildStockistFulfillmentEmail } from './emails/vinyl-email';
export { buildDigitalSaleEmail } from './emails/seller-email';
export { buildMerchSaleEmail } from './emails/merch-email';
export type { OrderItem } from './emails/types';
