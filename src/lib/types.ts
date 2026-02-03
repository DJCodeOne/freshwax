// src/lib/types.ts
// TypeScript interfaces for Firebase documents and common types

// ============================================
// BASE TYPES
// ============================================

export interface Timestamps {
  createdAt: string;
  updatedAt: string;
}

export interface Ratings {
  average: number;
  count: number;
  total: number;
}

// ============================================
// USER & AUTH
// ============================================

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
// RELEASES & TRACKS
// ============================================

export type ReleaseStatus = 'pending' | 'approved' | 'published' | 'rejected';

export interface Release extends Timestamps {
  id: string;
  title: string;
  artist: string;
  artistName: string;
  releaseName?: string;

  // Artwork URLs (multiple fields for compatibility)
  coverUrl?: string;
  coverArtUrl?: string;
  artworkUrl?: string;
  thumbUrl?: string;
  imageUrl?: string;

  // Details
  genre: string;
  description?: string;
  releaseDescription?: string;
  releaseDate: string;
  catalogNumber?: string;
  labelCode?: string;
  masteredBy?: string;

  // Pricing
  pricePerSale: number;
  trackPrice: number;

  // Name Your Own Price (NYOP) - digital album only
  nyopEnabled?: boolean;        // Toggle NYOP on/off
  nyopMinPrice?: number;        // Minimum price (can be 0 for free)
  nyopSuggestedPrice?: number;  // Pre-filled suggested price (optional)

  // Copyright
  copyrightYear?: string;
  copyrightHolder?: string;
  publishingRights?: string;
  publishingCompany?: string;

  // Vinyl
  vinylRelease?: boolean;
  vinylPrice?: number;
  vinylStock?: number;
  vinylSold?: number;

  // Per-release vinyl shipping (overrides artist defaults if set)
  vinylShippingUK?: number;              // UK shipping rate in GBP
  vinylShippingEU?: number;              // EU shipping rate in GBP
  vinylShippingIntl?: number;            // International shipping rate in GBP

  // Status
  status: ReleaseStatus;
  published: boolean;
  approved: boolean;

  // Storage
  storage?: 'r2' | 'firebase';
  r2FolderName?: string;
  r2FolderPath?: string;

  // Tracks
  tracks: Track[];

  // Stats
  plays: number;
  downloads: number;
  views: number;
  likes: number;
  ratings: Ratings;

  // Submission
  submissionId?: string;
  email?: string;
  submittedBy?: string;
  processedAt?: string;
  adminNotes?: string;
}

export interface Track {
  trackNumber: number;
  title: string;
  trackName?: string;
  mp3Url?: string;
  wavUrl?: string;
  previewUrl?: string;
  bpm?: string;
  key?: string;
  duration?: string;
  trackISRC?: string;
  featured?: string;
  remixer?: string;
  storage?: 'r2' | 'firebase';
}

// ============================================
// DJ MIXES
// ============================================

export interface DjMix extends Timestamps {
  id: string;
  userId: string;
  title: string;
  name?: string;
  djName: string;
  dj_name?: string;
  displayName?: string;

  // Media
  audioUrl?: string;
  audio_url?: string;
  artworkUrl?: string;
  imageUrl?: string;
  artwork_url?: string;

  // Details
  genre?: string;
  description?: string;
  shoutOuts?: string;
  duration?: number;

  // Tracklist
  tracklist?: string;
  tracklistArray?: string[];
  trackCount?: number;

  // Status
  published: boolean;
  featured?: boolean;
  allowDownload?: boolean;

  // Stats
  plays?: number;
  playCount?: number;
  likes?: number;
  likeCount?: number;
  downloads?: number;
  downloadCount?: number;
  commentCount?: number;
  comments?: MixComment[];
  ratings?: Ratings;

  // Activity dates
  last_played_date?: string;
  last_liked_date?: string;
  last_unliked_date?: string;
  last_download_date?: string;
  last_downloaded_date?: string;
}

export interface MixComment {
  userId: string;
  userName: string;
  comment: string;
  createdAt: string;
}

// ============================================
// LIVESTREAM
// ============================================

export type SlotStatus = 'available' | 'booked' | 'live' | 'ended' | 'cancelled';

export interface LivestreamSlot extends Timestamps {
  id: string;
  djId: string;
  djName: string;
  title?: string;
  genre?: string;

  // Schedule
  date: string;
  hour: number;
  startTime: string;
  endTime: string;

  // Stream
  status: SlotStatus;
  hlsUrl?: string;
  streamKey?: string;

  // Stats
  currentViewers?: number;
  peakViewers?: number;
  totalViews?: number;
  totalLikes?: number;
  averageRating?: number;
  ratingCount?: number;

  // Cleanup
  endedAt?: string;
  cleanupReason?: string;
}

export interface ChatMessage extends Timestamps {
  id: string;
  userId: string;
  userName: string;
  userPhotoURL?: string;
  message: string;
  isGif?: boolean;
  gifUrl?: string;
  isModerator?: boolean;
  isAdmin?: boolean;
}

export interface StreamReaction {
  id: string;
  slotId: string;
  userId: string;
  type: 'like' | 'rating';
  value?: number;
  createdAt: string;
}

// ============================================
// PLAYLIST
// ============================================

export type MediaPlatform = 'youtube' | 'vimeo' | 'soundcloud' | 'direct';

export interface PlaylistItem {
  id: string;
  url: string;
  platform: MediaPlatform;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedAt: string;
}

export interface UserPlaylist {
  userId: string;
  queue: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  lastUpdated: string;
}

export interface GlobalPlaylist {
  queue: GlobalPlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  lastUpdated: string;
  // Sync fields for real-time playback synchronization
  trackStartedAt?: string;  // ISO timestamp when current track started
  trackPosition?: number;   // Current position in seconds (for sync accuracy)
  reactionCount?: number;   // Global reaction count, resets per track
}

export interface GlobalPlaylistItem extends PlaylistItem {
  addedBy?: string;
  addedByName?: string;
}

// ============================================
// ORDERS & COMMERCE
// ============================================

export type OrderStatus = 'pending' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

export interface Order extends Timestamps {
  id: string;
  customerId: string;
  artistId?: string;

  // Customer
  customer: OrderCustomer;
  shipping: OrderAddress;

  // Items
  items: OrderItem[];

  // Pricing
  subtotal: number;
  shippingCost: number;
  discount?: number;
  total: number;

  // Payment
  status: OrderStatus;
  paymentIntentId?: string;
  paidAt?: string;

  // Shipping
  trackingNumber?: string;
  shippedAt?: string;
  deliveredAt?: string;

  // Notes
  notes?: string;
  adminNotes?: string;
}

export interface OrderCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface OrderAddress {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country: string;
}

export interface OrderItem {
  id: string;
  type: 'release' | 'merch' | 'giftcard' | 'track';
  title: string;
  quantity: number;
  price: number;
  artistId?: string;
  size?: string;
  color?: string;
  imageUrl?: string;
}

// ============================================
// MERCH
// ============================================

export interface MerchProduct extends Timestamps {
  id: string;
  supplierId?: string;
  name: string;
  title?: string;
  description?: string;
  price: number;
  salePrice?: number;
  category: string;

  // Images
  imageUrl?: string;
  images?: string[];

  // Inventory
  stock: number;
  lowStockThreshold?: number;
  sizes?: string[];
  colors?: string[];

  // Status
  published: boolean;
  featured?: boolean;

  // Stats
  views?: number;
  sales?: number;
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
// VINYL CRATES MARKETPLACE
// ============================================

export type VinylCondition = 'M' | 'NM' | 'VG+' | 'VG' | 'G+' | 'G' | 'F' | 'P';
export type VinylListingStatus = 'draft' | 'pending' | 'published' | 'sold' | 'removed';

export interface VinylListing extends Timestamps {
  id: string;
  sellerId: string;
  sellerName: string;
  sellerStoreName?: string;

  // Record details
  artist: string;
  title: string;
  label?: string;
  catalogNumber?: string;
  releaseYear?: string;
  genre?: string;
  format?: string; // LP, EP, 12", 7", etc.

  // Condition
  mediaCondition: VinylCondition;
  sleeveCondition?: VinylCondition;
  conditionNotes?: string;

  // Pricing & shipping
  price: number;
  shippingCost?: number;
  shipsFrom?: string;

  // Media
  images: string[];
  audioSampleUrl?: string;

  // Description
  description?: string;

  // Status
  status: VinylListingStatus;
  featured?: boolean;

  // Stats
  views?: number;
  saves?: number;
}

export interface VinylSeller extends Timestamps {
  id: string;
  userId: string;
  storeName: string;
  description?: string;
  location?: string;
  discogsUrl?: string;

  // Status
  approved: boolean;
  suspended?: boolean;

  // Stats
  totalSales?: number;
  activeListings?: number;
  ratings?: SellerRatings;
}

export interface SellerRatings {
  average: number;
  count: number;
  breakdown: {
    communication: number;
    accuracy: number;
    shipping: number;
  };
}

export interface SellerReview extends Timestamps {
  id: string;
  sellerId: string;
  buyerId: string;
  buyerName: string;
  orderId: string;
  rating: number;
  communicationRating?: number;
  accuracyRating?: number;
  shippingRating?: number;
  review?: string;
}

// ============================================
// API REQUEST/RESPONSE TYPES
// ============================================

export interface ApiSuccess<T = unknown> {
  success: true;
  data?: T;
  message?: string;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ============================================
// STRIPE CONNECT PAYOUTS
// ============================================

export type PayoutStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export interface Payout extends Timestamps {
  id: string;
  artistId: string;
  artistName: string;
  artistEmail: string;
  stripeConnectId?: string;
  stripeTransferId?: string;          // tr_xxx
  paypalEmail?: string;
  paypalBatchId?: string;
  paypalPayoutItemId?: string;
  payoutMethod?: 'stripe' | 'paypal';

  // Order reference
  orderId: string;
  orderNumber: string;

  // Amount (total = itemAmount + shippingAmount)
  amount: number;                     // Total amount in GBP
  itemAmount?: number;                // Amount for items only
  shippingAmount?: number;            // Amount for vinyl shipping (goes to artist)
  currency: string;

  // Status
  status: PayoutStatus;
  failureReason?: string;
  completedAt?: string;
  reversedAt?: string;
  reversedAmount?: number;
}

export type PendingPayoutStatus = 'awaiting_connect' | 'retry_pending' | 'processing' | 'resolved';

export interface PendingPayout extends Timestamps {
  id: string;
  artistId: string;
  artistName: string;
  artistEmail: string;
  paypalEmail?: string;
  payoutMethod?: 'stripe' | 'paypal';

  // Order reference
  orderId: string;
  orderNumber: string;

  // Amount (total = itemAmount + shippingAmount)
  amount: number;                     // Total amount in GBP
  itemAmount?: number;                // Amount for items only
  shippingAmount?: number;            // Amount for vinyl shipping (goes to artist)
  currency: string;

  // Status
  status: PendingPayoutStatus;
  failureReason?: string;
  originalPayoutId?: string;          // If this is a retry from failed payout
  notificationSent?: boolean;
  resolvedAt?: string;
  resolvedPayoutId?: string;          // Link to successful payout when resolved
}

// ============================================
// DISPUTES
// ============================================

export type DisputeStatus = 'open' | 'won' | 'lost' | 'closed';

export interface Dispute extends Timestamps {
  id: string;
  stripeDisputeId: string;            // dp_xxx
  stripeChargeId: string;             // ch_xxx
  stripePaymentIntentId?: string;     // pi_xxx

  // Order reference
  orderId?: string;
  orderNumber?: string;

  // Artist info (if transfer was reversed)
  artistId?: string;
  artistName?: string;
  transferId?: string;                // tr_xxx - the transfer that was reversed
  transferReversalId?: string;        // trr_xxx

  // Amounts
  amount: number;                     // Disputed amount in GBP
  currency: string;
  amountRecovered?: number;           // Amount recovered from artist

  // Dispute details
  reason: string;                     // e.g., 'fraudulent', 'product_not_received'
  status: DisputeStatus;
  evidenceDueBy?: string;

  // Resolution
  resolvedAt?: string;
  outcome?: 'won' | 'lost';
  netImpact?: number;                 // Final financial impact to platform
}
