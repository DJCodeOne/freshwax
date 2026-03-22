// src/lib/types/user.ts
// User, auth, and artist-related types

import type { Timestamps } from './base';

export interface User extends Timestamps {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  roles?: UserRoles;
  pendingRoles?: PendingRole[];
  approved?: boolean;
  suspended?: boolean;
  lastLoginAt?: string;
  'go-liveBypassed'?: boolean;
  bypassedAt?: string;
  bypassedBy?: string;
  quickAccessCode?: string;
}

export interface UserRoles {
  admin?: boolean;
  dj?: boolean;
  artist?: boolean;
  merchSupplier?: boolean;
  merchSeller?: boolean;
  vinylSeller?: boolean;
}

export interface PendingRole {
  role: string;
  requestedAt: string;
  reason?: string;
}

export type StripeConnectStatus = 'not_started' | 'onboarding' | 'active' | 'restricted' | 'disabled';

export interface Artist extends Timestamps {
  id: string;
  userId: string;
  name: string;
  artistName: string;
  displayName?: string;
  email: string;
  phone?: string;
  bio?: string;
  photoURL?: string;
  socialLinks?: SocialLinks;
  approved: boolean;
  suspended?: boolean;
  isArtist?: boolean;
  isMerchSupplier?: boolean;
  adminNotes?: string;
  revokedAt?: string;
  revokedBy?: string;

  // Stripe Connect fields
  stripeConnectId?: string;              // Stripe account ID (acct_xxx)
  stripeConnectStatus?: StripeConnectStatus;
  stripeChargesEnabled?: boolean;
  stripePayoutsEnabled?: boolean;
  stripeDetailsSubmitted?: boolean;
  stripeConnectedAt?: string;
  stripeLastUpdated?: string;

  // Earnings tracking
  totalEarnings?: number;                // Lifetime earnings in GBP
  pendingBalance?: number;               // Amount pending payout
  lastPayoutAt?: string;

  // Vinyl shipping defaults (artist sets these, can be overridden per-release)
  vinylShippingUK?: number;              // Default UK shipping rate in GBP
  vinylShippingEU?: number;              // Default EU shipping rate in GBP
  vinylShippingIntl?: number;            // Default international shipping rate in GBP
  vinylShipsFrom?: string;               // Artist's shipping location
}

export interface SocialLinks {
  website?: string;
  instagram?: string;
  soundcloud?: string;
  spotify?: string;
  bandcamp?: string;
  twitter?: string;
  facebook?: string;
}

// ============================================
// PENDING ROLE REQUESTS
// ============================================

export type RoleRequestStatus = 'pending' | 'approved' | 'rejected';

export interface PendingRoleRequest extends Timestamps {
  id: string;
  userId: string;
  email: string;
  displayName?: string;
  role: string;
  reason?: string;
  status: RoleRequestStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

// ============================================
// NEWSLETTER & CONTACT
// ============================================

export interface Subscriber {
  id: string;
  email: string;
  source?: string;
  subscribedAt: string;
  unsubscribedAt?: string;
  active: boolean;
}

export interface ContactSubmission extends Timestamps {
  id: string;
  name: string;
  email: string;
  subject?: string;
  message: string;
  read?: boolean;
  replied?: boolean;
}
