// types.ts - TypeScript interfaces for merch processor

export interface Env {
  // R2 Bucket
  MERCH_BUCKET: R2Bucket;

  // Environment variables
  R2_PUBLIC_DOMAIN: string;

  // Secrets
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  RESEND_API_KEY: string;
  ADMIN_EMAIL: string;
}

export interface MerchVariant {
  size?: string;
  color?: string;
  sku?: string;
  stock: number;
  price?: number;
}

export interface MerchSubmissionMetadata {
  // Supplier Info
  supplierName: string;
  supplierId?: string;
  email: string;
  userId?: string;

  // Product Details
  name: string;
  title?: string;
  description?: string;
  category: string;
  subcategory?: string;

  // Pricing
  price: number;
  compareAtPrice?: number;
  costPrice?: number;

  // Inventory
  stock: number;
  sku?: string;
  barcode?: string;
  trackInventory?: boolean;

  // Variants
  hasVariants?: boolean;
  variants?: MerchVariant[];

  // Attributes
  sizes?: string[];
  colors?: string[];
  material?: string;
  weight?: number;
  dimensions?: {
    length?: number;
    width?: number;
    height?: number;
  };

  // Settings
  published?: boolean;
  featured?: boolean;

  // Shipping
  requiresShipping?: boolean;
  shippingWeight?: number;

  // SEO
  tags?: string[];

  // Metadata
  submittedAt: string;
  uploadedAt?: string;
}

export interface ProcessedMerch {
  id: string;
  name: string;
  title: string;
  slug: string;
  description: string;

  // Supplier
  supplierName: string;
  supplierId?: string;
  userId?: string;
  email?: string;

  // Category
  category: string;
  subcategory?: string;

  // Pricing
  price: number;
  compareAtPrice?: number;
  costPrice?: number;

  // Images
  images: string[];
  imageUrl: string;
  thumbnailUrl: string;

  // Inventory
  stock: number;
  sku?: string;
  barcode?: string;
  trackInventory: boolean;
  inStock: boolean;

  // Variants
  hasVariants: boolean;
  variants: MerchVariant[];

  // Attributes
  sizes?: string[];
  colors?: string[];
  material?: string;
  weight?: number;
  dimensions?: {
    length?: number;
    width?: number;
    height?: number;
  };

  // Settings
  published: boolean;
  featured: boolean;
  approved: boolean;

  // Shipping
  requiresShipping: boolean;
  shippingWeight?: number;

  // SEO
  tags: string[];

  // Stats
  views: number;
  sales: number;

  // Status
  status: 'active' | 'draft' | 'archived';
  storage: 'r2';

  // Timestamps
  createdAt: string;
  updatedAt: string;

  // R2 metadata
  folder_path: string;
}

export interface ProcessingResult {
  success: boolean;
  productId?: string;
  error?: string;
}
