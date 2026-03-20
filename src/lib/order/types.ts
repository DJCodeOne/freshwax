// src/lib/order/types.ts
// Shared types, interfaces, logger, and constants for order modules

import { createLogger } from '../api-utils';

export const log = createLogger('[order-utils]');

export const RESERVATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Shared type for cart/order items flowing through the system
export interface CartItem {
  type?: string;
  productId?: string;
  releaseId?: string;
  id?: string;
  sellerId?: string;
  name?: string;
  title?: string;
  artist?: string;
  price?: number;
  originalPrice?: number;
  quantity?: number;
  size?: string;
  color?: string;
  trackId?: string;
  isPreOrder?: boolean;
  releaseDate?: string;
  image?: string;
  artwork?: string;
  format?: string;
  condition?: string;
  artistId?: string;
  artistName?: string;
  sellerName?: string;
  sellerEmail?: string;
  stockistEmail?: string;
  artistEmail?: string;
  brandAccountId?: string;
  brandName?: string;
  discountPercent?: number;
  shippingCost?: number;
  cratesShippingCost?: number;
  isCratesItem?: boolean;
  vinylShippingUK?: number;
  vinylShippingEU?: number;
  vinylShippingIntl?: number;
  artistVinylShippingUK?: number;
  artistVinylShippingEU?: number;
  artistVinylShippingIntl?: number;
  downloads?: Record<string, unknown>;
  [key: string]: unknown;
}

// Variant stock entry shape
export interface VariantStockEntry {
  stock?: number;
  reserved?: number;
  sold?: number;
  sku?: string;
  [key: string]: unknown;
}
