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
  vinylShippingAdditional?: number; // per additional record (50p default)
  artistVinylShippingUK?: number;
  artistVinylShippingEU?: number;
  artistVinylShippingIntl?: number;
  artistVinylShippingAdditional?: number;
  // Multi-part vinyl: which pressed part this line refers to (e.g. 'part-1').
  // Set only when type='vinyl' and the release.vinylParts array is present.
  // Stock checks scope to vinylParts[idx].stock, prices to vinylParts[idx].price,
  // fulfillment emails name the part via vinylPartName.
  vinylPartId?: string | null;
  vinylPartName?: string | null;
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
