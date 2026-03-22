// src/lib/types/product.ts
// Product, release, merch, DJ mix, livestream, and playlist types

import type { Timestamps, Ratings } from './base';

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
  thumbUrl?: string;
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
