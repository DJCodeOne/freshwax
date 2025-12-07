// src/lib/user-profile-cache.ts
// Client-side user profile caching to reduce Firebase reads
// Uses sessionStorage for caching and the consolidated API endpoint

export interface UserProfile {
  success: boolean;
  isCustomer: boolean;
  isArtist: boolean;
  isApproved: boolean;
  isPro: boolean;
  roles: {
    customer: boolean;
    artist: boolean;
    dj: boolean;
    merchSupplier: boolean;
  };
  name: string;
  partnerDisplayName: string;
  avatarUrl: string;
  canBuy: boolean;
  canSell: boolean;
  cachedAt?: number;
}

const CACHE_KEY_PREFIX = 'fw_user_profile_';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Get user profile from cache or API
 * Reduces Firebase reads by caching user profile data
 * 
 * @param uid - User ID to fetch profile for
 * @param forceRefresh - Skip cache and fetch fresh data
 * @returns UserProfile object
 */
export async function getUserProfile(uid: string, forceRefresh = false): Promise<UserProfile> {
  if (!uid) {
    return getEmptyProfile();
  }
  
  const cacheKey = CACHE_KEY_PREFIX + uid;
  
  // Check cache first (unless forcing refresh)
  if (!forceRefresh && typeof sessionStorage !== 'undefined') {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const profile: UserProfile = JSON.parse(cached);
        // Check if cache is still valid (5 minutes)
        if (profile.cachedAt && Date.now() - profile.cachedAt < CACHE_DURATION) {
          return profile;
        }
      }
    } catch (e) {
      // Cache read failed, continue to API
    }
  }
  
  // Fetch from API
  try {
    const response = await fetch(`/api/get-user-type?uid=${encodeURIComponent(uid)}`);
    if (!response.ok) {
      throw new Error('API request failed');
    }
    
    const profile: UserProfile = await response.json();
    profile.cachedAt = Date.now();
    
    // Cache the result
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(profile));
      } catch (e) {
        // Cache write failed, continue anyway
      }
    }
    
    return profile;
  } catch (error) {
    console.error('[user-profile-cache] Failed to fetch profile:', error);
    return getEmptyProfile();
  }
}

/**
 * Clear cached profile for a user
 * Call this after profile updates
 */
export function clearUserProfileCache(uid?: string): void {
  if (typeof sessionStorage === 'undefined') return;
  
  if (uid) {
    sessionStorage.removeItem(CACHE_KEY_PREFIX + uid);
  } else {
    // Clear all user profile caches
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(CACHE_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => sessionStorage.removeItem(key));
  }
}

/**
 * Get current user's profile from cache only (no API call)
 * Useful for synchronous checks
 */
export function getCachedProfile(uid: string): UserProfile | null {
  if (!uid || typeof sessionStorage === 'undefined') return null;
  
  try {
    const cached = sessionStorage.getItem(CACHE_KEY_PREFIX + uid);
    if (cached) {
      const profile: UserProfile = JSON.parse(cached);
      if (profile.cachedAt && Date.now() - profile.cachedAt < CACHE_DURATION) {
        return profile;
      }
    }
  } catch (e) {
    // Ignore cache errors
  }
  
  return null;
}

function getEmptyProfile(): UserProfile {
  return {
    success: false,
    isCustomer: false,
    isArtist: false,
    isApproved: false,
    isPro: false,
    roles: {
      customer: false,
      artist: false,
      dj: false,
      merchSupplier: false
    },
    name: '',
    partnerDisplayName: '',
    avatarUrl: '',
    canBuy: false,
    canSell: false
  };
}

/**
 * Preload user profile into cache
 * Call this after login to ensure profile is cached
 */
export async function preloadUserProfile(uid: string): Promise<UserProfile> {
  return getUserProfile(uid, true); // Force refresh
}
