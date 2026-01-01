// src/lib/subscription.ts
// Subscription tier management for Fresh Wax

export const SUBSCRIPTION_TIERS = {
  FREE: 'free',
  PRO: 'pro',
} as const;

export type SubscriptionTier = typeof SUBSCRIPTION_TIERS[keyof typeof SUBSCRIPTION_TIERS];

export const TIER_LIMITS = {
  [SUBSCRIPTION_TIERS.FREE]: {
    mixUploadsPerWeek: 2,
    streamHoursPerDay: 2, // Can be split into 2x1 hour slots or run concurrently
    maxConcurrentSlots: 2,
    canBookLongEvents: false,
    playlistTrackLimit: 100, // Max tracks in personal playlist
    name: 'Standard',
    price: 0,
  },
  [SUBSCRIPTION_TIERS.PRO]: {
    mixUploadsPerWeek: 5,
    streamHoursPerDay: 2, // Base limit, Plus can book long events up to 24 hours
    maxConcurrentSlots: 2,
    canBookLongEvents: true, // Can book multiple slots for day-long events up to 24 hours
    playlistTrackLimit: 1000, // Max tracks in personal playlist
    name: 'Plus',
    price: 10, // £10/year
  },
} as const;

// Event request for extended streaming hours
export interface EventRequest {
  id?: string;
  userId: string;
  userEmail: string;
  userName: string;
  eventName: string;
  eventDescription: string;
  eventDate: string; // YYYY-MM-DD
  hoursRequested: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
}

export const PRO_ANNUAL_PRICE = 10; // £10 per year

export interface UserSubscription {
  tier: SubscriptionTier;
  subscriptionId?: string;
  subscribedAt?: string;
  expiresAt?: string;
  paymentMethod?: string;
}

export interface UserUsage {
  mixUploadsThisWeek: number;
  weekStartDate: string; // ISO date of week start (Monday)
  streamMinutesToday: number;
  dayDate: string; // ISO date (YYYY-MM-DD)
}

// Get the start of the current week (Monday)
export function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

// Get today's date string
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Check if subscription is active
export function isSubscriptionActive(subscription?: UserSubscription): boolean {
  if (!subscription) return false;
  if (subscription.tier === SUBSCRIPTION_TIERS.FREE) return true;
  if (!subscription.expiresAt) return false;
  return new Date(subscription.expiresAt) > new Date();
}

// Get user's effective tier
export function getEffectiveTier(subscription?: UserSubscription): SubscriptionTier {
  if (!subscription) return SUBSCRIPTION_TIERS.FREE;
  if (subscription.tier === SUBSCRIPTION_TIERS.PRO && isSubscriptionActive(subscription)) {
    return SUBSCRIPTION_TIERS.PRO;
  }
  return SUBSCRIPTION_TIERS.FREE;
}

// Check if user can upload a mix
export function canUploadMix(tier: SubscriptionTier, usage: UserUsage): { allowed: boolean; reason?: string; remaining?: number } {
  const limits = TIER_LIMITS[tier];
  const weekStart = getWeekStart();

  // Reset count if new week
  const uploadsThisWeek = usage.weekStartDate === weekStart ? usage.mixUploadsThisWeek : 0;

  if (limits.mixUploadsPerWeek === Infinity) {
    return { allowed: true, remaining: Infinity };
  }

  const remaining = limits.mixUploadsPerWeek - uploadsThisWeek;

  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `You've reached your weekly limit of ${limits.mixUploadsPerWeek} mix uploads. Go Plus for 5 uploads per week.`,
      remaining: 0
    };
  }

  return { allowed: true, remaining };
}

// Check if user can book a stream slot
// approvedEventHours: extra hours granted from an approved event request
export function canBookStreamSlot(
  tier: SubscriptionTier,
  usage: UserUsage,
  slotDurationMinutes: number = 60,
  approvedEventHours: number = 0
): { allowed: boolean; reason?: string; remainingMinutes?: number } {
  const limits = TIER_LIMITS[tier];
  const today = getTodayDate();

  // Reset count if new day
  const minutesToday = usage.dayDate === today ? usage.streamMinutesToday : 0;

  // Base hours + any approved event hours
  const totalHoursAllowed = limits.streamHoursPerDay + approvedEventHours;
  const maxMinutes = totalHoursAllowed * 60;
  const remainingMinutes = maxMinutes - minutesToday;

  if (remainingMinutes < slotDurationMinutes) {
    const hoursUsed = Math.floor(minutesToday / 60);
    const hoursLimit = totalHoursAllowed;
    const upgradeMsg = tier === SUBSCRIPTION_TIERS.FREE
      ? 'Go Plus for long duration events up to 24 hours.'
      : (approvedEventHours === 0 ? 'Use Long Event to book extended hours.' : '');
    return {
      allowed: false,
      reason: `You've used ${hoursUsed} of your ${hoursLimit} hour${hoursLimit > 1 ? 's' : ''} today. ${upgradeMsg}`,
      remainingMinutes
    };
  }

  return { allowed: true, remainingMinutes };
}

// Check if user can add track to playlist
export function canAddToPlaylist(tier: SubscriptionTier, currentTrackCount: number): { allowed: boolean; reason?: string; limit: number; remaining: number } {
  const limits = TIER_LIMITS[tier];
  const limit = limits.playlistTrackLimit;
  const remaining = limit - currentTrackCount;

  if (remaining <= 0) {
    const upgradeMsg = tier === SUBSCRIPTION_TIERS.FREE
      ? 'Go Plus for up to 1,000 tracks in your playlist.'
      : '';
    return {
      allowed: false,
      reason: `Your playlist is full (${limit} tracks). ${upgradeMsg}`,
      limit,
      remaining: 0
    };
  }

  return { allowed: true, limit, remaining };
}

// Format tier benefits for display
export function getTierBenefits(tier: SubscriptionTier): string[] {
  const limits = TIER_LIMITS[tier];

  if (tier === SUBSCRIPTION_TIERS.FREE) {
    return [
      `${limits.mixUploadsPerWeek} DJ mix uploads per week`,
      `${limits.streamHoursPerDay} hours live streaming per day`,
      'Can split into 2x1 hour slots',
      `${limits.playlistTrackLimit} tracks in personal playlist`,
      'Access to DJ Lobby',
      'Basic profile page',
    ];
  }

  return [
    `${limits.mixUploadsPerWeek} DJ mix uploads per week`,
    `${limits.streamHoursPerDay} hours live streaming per day`,
    'Long duration events up to 24 hours',
    'Book multiple slots for day-long events',
    `${limits.playlistTrackLimit.toLocaleString()} tracks in personal playlist`,
    'Record live stream button',
    'Gold crown on chat avatar',
    'Priority in DJ Lobby queue',
  ];
}
