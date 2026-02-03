/**
 * Vinyl API Client
 * Connects to the dedicated vinyl-api Cloudflare Worker
 */

// Worker URL - can be configured for different environments
const VINYL_API_URL = import.meta.env.PUBLIC_VINYL_API_URL || 'https://vinyl-api.davidhagon.workers.dev';

interface VinylListing {
  id: string;
  sellerId: string;
  sellerName: string;
  title: string;
  artist: string;
  label?: string;
  catalogNumber?: string;
  format: string;
  releaseYear?: number;
  genre?: string;
  mediaCondition: string;
  sleeveCondition: string;
  conditionNotes?: string;
  price: number;
  originalPrice?: number;
  discountPercent: number;
  shippingCost: number;
  dealType: string;
  dealDescription?: string;
  description?: string;
  images: string[];
  tracks: any[];
  audioSampleUrl?: string;
  audioSampleDuration?: number;
  status: string;
  featured: boolean;
  views: number;
  saves: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

interface ApiResponse<T> {
  success: boolean;
  error?: string;
  listing?: T;
  listings?: T[];
  count?: number;
  genres?: string[];
  collections?: any[];
}

// Helper to get auth token from localStorage
function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('firebaseIdToken');
}

// Make authenticated request
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${VINYL_API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  return response.json();
}

// =============================================
// PUBLIC API (no auth required)
// =============================================

/**
 * Get published vinyl listings
 */
export async function getPublishedListings(options: {
  collection?: string;
  genre?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ listings: VinylListing[]; count: number; genres: string[] }> {
  const params = new URLSearchParams();
  if (options.collection) params.set('collection', options.collection);
  if (options.genre) params.set('genre', options.genre);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  const query = params.toString();
  const result = await apiRequest<VinylListing>(`/listings${query ? `?${query}` : ''}`);

  return {
    listings: result.listings || [],
    count: result.count || 0,
    genres: result.genres || [],
  };
}

/**
 * Get single listing by ID
 */
export async function getListing(id: string): Promise<VinylListing | null> {
  const result = await apiRequest<VinylListing>(`/listings/${id}`);
  return result.listing || null;
}

/**
 * Get listings with discounts
 */
export async function getDeals(limit = 50): Promise<VinylListing[]> {
  const result = await apiRequest<VinylListing>(`/listings?type=deals&limit=${limit}`);
  return result.listings || [];
}

/**
 * Get seller collections
 */
export async function getCollections(): Promise<any[]> {
  const result = await apiRequest<any>('/listings?type=collections');
  return result.collections || [];
}

/**
 * Get available genres
 */
export async function getGenres(): Promise<string[]> {
  const result = await apiRequest<any>('/listings?type=genres');
  return result.genres || [];
}

// =============================================
// SELLER API (auth required)
// =============================================

/**
 * Get seller's own listings
 */
export async function getSellerListings(sellerId: string): Promise<VinylListing[]> {
  const result = await apiRequest<VinylListing>(`/seller/${sellerId}/listings`);
  return result.listings || [];
}

/**
 * Create a new listing
 */
export async function createListing(data: Partial<VinylListing>): Promise<{ listing: VinylListing; listingId: string } | null> {
  const result = await apiRequest<VinylListing>('/listings', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (result.success && result.listing) {
    return { listing: result.listing, listingId: result.listing.id };
  }

  throw new Error(result.error || 'Failed to create listing');
}

/**
 * Update a listing
 */
export async function updateListing(id: string, data: Partial<VinylListing>): Promise<VinylListing | null> {
  const result = await apiRequest<VinylListing>(`/listings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  if (result.success) {
    return result.listing || null;
  }

  throw new Error(result.error || 'Failed to update listing');
}

/**
 * Publish a listing
 */
export async function publishListing(id: string): Promise<VinylListing | null> {
  const result = await apiRequest<VinylListing>(`/listings/${id}/publish`, {
    method: 'POST',
  });

  if (result.success) {
    return result.listing || null;
  }

  throw new Error(result.error || 'Failed to publish listing');
}

/**
 * Unpublish a listing
 */
export async function unpublishListing(id: string): Promise<VinylListing | null> {
  const result = await apiRequest<VinylListing>(`/listings/${id}/unpublish`, {
    method: 'POST',
  });

  if (result.success) {
    return result.listing || null;
  }

  throw new Error(result.error || 'Failed to unpublish listing');
}

/**
 * Delete a listing
 */
export async function deleteListing(id: string): Promise<boolean> {
  const result = await apiRequest<VinylListing>(`/listings/${id}`, {
    method: 'DELETE',
  });

  if (result.success) {
    return true;
  }

  throw new Error(result.error || 'Failed to delete listing');
}

// =============================================
// FILE UPLOADS
// =============================================

/**
 * Upload an image
 */
export async function uploadImage(
  file: File,
  sellerId: string,
  listingId: string,
  imageIndex: number
): Promise<{ url: string; key: string }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('sellerId', sellerId);
  formData.append('listingId', listingId);
  formData.append('imageIndex', String(imageIndex));

  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${VINYL_API_URL}/upload/image`, {
    method: 'POST',
    headers,
    body: formData,
  });

  const result = await response.json();

  if (result.success) {
    return { url: result.url, key: result.key };
  }

  throw new Error(result.error || 'Failed to upload image');
}

/**
 * Upload an audio sample
 */
export async function uploadAudio(
  file: File,
  sellerId: string,
  listingId: string,
  trackIndex: number,
  duration: number
): Promise<{ url: string; key: string; duration: number }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('sellerId', sellerId);
  formData.append('listingId', listingId);
  formData.append('trackIndex', String(trackIndex));
  formData.append('duration', String(duration));

  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${VINYL_API_URL}/upload/audio`, {
    method: 'POST',
    headers,
    body: formData,
  });

  const result = await response.json();

  if (result.success) {
    return { url: result.url, key: result.key, duration: result.duration };
  }

  throw new Error(result.error || 'Failed to upload audio');
}

// Export API URL for direct access if needed
export const vinylApiUrl = VINYL_API_URL;
