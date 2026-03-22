// src/lib/order/emails/types.ts
// Shared types for order email builders

// Minimal type for order items flowing through the pipeline
export interface OrderItem {
  id?: string;
  productId?: string;
  releaseId?: string;
  trackId?: string;
  name: string;
  type?: string;
  price: number;
  quantity: number;
  size?: string;
  color?: string;
  image?: string;
  artwork?: string;
  artist?: string;
  artistId?: string;
  artistName?: string;
  artistEmail?: string;
  title?: string;
  isPreOrder?: boolean;
  releaseDate?: string;
  sellerId?: string;
  supplierId?: string;
  sellerEmail?: string;
  stockistEmail?: string;
  downloads?: { artworkUrl?: string; tracks?: { name: string; mp3Url?: string | null; wavUrl?: string | null }[] };
  [key: string]: unknown;
}
