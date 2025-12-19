// Type definitions for Fresh Wax API Worker

export interface Env {
  // Environment variables
  FIREBASE_PROJECT_ID: string;
  CORS_ORIGIN: string;
  ENVIRONMENT: string;

  // Secrets (set via wrangler secret put)
  FIREBASE_SERVICE_ACCOUNT_KEY: string;
  RESEND_API_KEY: string;
  ADMIN_SECRET_KEY: string;
}

// Firebase types
export interface FirestoreDocument {
  name: string;
  fields: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

export interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  nullValue?: null;
  arrayValue?: { values: FirestoreValue[] };
  mapValue?: { fields: Record<string, FirestoreValue> };
}

// User types
export interface User {
  id: string;
  uid: string;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  roles: UserRoles;
  pendingRoles?: PendingRoles;
}

export interface UserRoles {
  customer: boolean;
  djEligible: boolean;
  artist: boolean;
  merchSeller: boolean;
  admin?: boolean;
}

export interface PendingRoles {
  artist?: PendingRoleRequest;
  merchSeller?: PendingRoleRequest;
  djBypass?: PendingRoleRequest;
}

export interface PendingRoleRequest {
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  approvedAt?: string;
  deniedAt?: string;
  approvedBy?: string;
  deniedBy?: string;
  denialReason?: string;
  // Artist-specific
  artistName?: string;
  bio?: string;
  links?: string;
  // Merch-specific
  businessName?: string;
  description?: string;
  website?: string;
  // DJ Bypass-specific
  reason?: string;
}

// Artist/Partner types
export interface Artist {
  id: string;
  userId: string;
  artistName: string;
  name: string;
  displayName: string;
  email: string;
  phone?: string;
  bio?: string;
  links?: string;
  businessName?: string;
  isArtist: boolean;
  isDJ: boolean;
  isMerchSupplier: boolean;
  approved: boolean;
  suspended: boolean;
  approvedAt?: string;
  approvedBy?: string;
  registeredAt: string;
  createdAt: string;
  updatedAt: string;
  avatarUrl?: string;
  adminNotes?: string;
}

// Customer types
export interface Customer {
  id: string;
  uid: string;
  email: string;
  displayName: string;
  fullName?: string;
  phone?: string;
  address?: Address;
  shippingAddress?: Address;
  createdAt: string;
  updatedAt?: string;
  roles?: Partial<UserRoles>;
  isArtist?: boolean;
  isMerchSupplier?: boolean;
  approved?: boolean;
  followedArtists?: string[];
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  county?: string;
  postcode: string;
  country: string;
}

// Order types
export interface Order {
  id: string;
  orderId: string;
  userId: string;
  customerId: string;
  email: string;
  status: 'pending' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  currency: string;
  shippingAddress: Address;
  paymentMethod: string;
  paymentIntentId?: string;
  createdAt: string;
  updatedAt: string;
  shippedAt?: string;
  deliveredAt?: string;
  notes?: string;
}

export interface OrderItem {
  id: string;
  type: 'vinyl' | 'digital' | 'merch' | 'giftcard';
  name: string;
  artist?: string;
  price: number;
  quantity: number;
  imageUrl?: string;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  [key: string]: any; // Allow additional properties
}

// Request context
export interface RequestContext {
  env: Env;
  userId?: string;
  isAdmin?: boolean;
}
