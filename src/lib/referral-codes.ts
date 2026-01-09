// src/lib/referral-codes.ts
// KV-based referral code system - separate from gift cards for security
// Uses Cloudflare KV for fast lookups without Firebase reads

export interface ReferralCode {
  code: string;
  creatorId: string;
  creatorName: string;
  discountPercent: number;  // e.g., 50 for 50% off
  restrictedTo?: string;    // e.g., 'pro_upgrade' for Plus subscription only
  maxUses: number;          // Usually 1 for referral codes
  usedCount: number;
  usedBy?: string[];        // Array of user IDs who used this code
  createdAt: string;
  expiresAt: string;
  active: boolean;
}

// Generate a unique referral code
export function generateReferralCode(creatorName: string): string {
  const prefix = 'FWX';
  const namePart = creatorName
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 4)
    .toUpperCase() || 'PLUS';
  const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${namePart}${randomPart}`;
}

// Create a new referral code object
// Hard deadline for all referral codes
export const REFERRAL_CODE_DEADLINE = new Date('2026-12-26T23:59:59Z');

export function createReferralCode(
  creatorId: string,
  creatorName: string,
  discountPercent: number = 50,
  restrictedTo?: string
): ReferralCode {
  const code = generateReferralCode(creatorName);
  const now = new Date();

  return {
    code,
    creatorId,
    creatorName,
    discountPercent,
    restrictedTo,
    maxUses: 1,
    usedCount: 0,
    usedBy: [],
    createdAt: now.toISOString(),
    expiresAt: REFERRAL_CODE_DEADLINE.toISOString(), // All codes expire Dec 26, 2026
    active: true
  };
}

// KV key helpers
export const KV_KEYS = {
  // Code lookup: referral:code:FWXPLUS1234 -> ReferralCode data
  byCode: (code: string) => `referral:code:${code.toUpperCase()}`,
  // User's code: referral:user:userId -> code string (to check if user has a code)
  byUser: (userId: string) => `referral:user:${userId}`,
};

// Save referral code to KV
export async function saveReferralCode(kv: KVNamespace, referralCode: ReferralCode): Promise<void> {
  // Save code data
  await kv.put(
    KV_KEYS.byCode(referralCode.code),
    JSON.stringify(referralCode),
    { expirationTtl: 365 * 24 * 60 * 60 } // 1 year TTL
  );

  // Save user -> code mapping
  await kv.put(
    KV_KEYS.byUser(referralCode.creatorId),
    referralCode.code,
    { expirationTtl: 365 * 24 * 60 * 60 }
  );
}

// Get referral code by code string
export async function getReferralCode(kv: KVNamespace, code: string): Promise<ReferralCode | null> {
  const data = await kv.get(KV_KEYS.byCode(code.toUpperCase()));
  if (!data) return null;
  try {
    return JSON.parse(data) as ReferralCode;
  } catch {
    return null;
  }
}

// Get user's referral code
export async function getUserReferralCode(kv: KVNamespace, userId: string): Promise<string | null> {
  return await kv.get(KV_KEYS.byUser(userId));
}

// Validate a referral code for use
export async function validateReferralCode(
  kv: KVNamespace,
  code: string,
  forUserId: string,
  forPurpose?: string
): Promise<{ valid: boolean; error?: string; referralCode?: ReferralCode }> {
  const referralCode = await getReferralCode(kv, code);

  if (!referralCode) {
    return { valid: false, error: 'Invalid referral code' };
  }

  if (!referralCode.active) {
    return { valid: false, error: 'This code is no longer active' };
  }

  if (new Date(referralCode.expiresAt) < new Date()) {
    return { valid: false, error: 'This code has expired' };
  }

  if (referralCode.usedCount >= referralCode.maxUses) {
    return { valid: false, error: 'This code has already been used' };
  }

  if (referralCode.creatorId === forUserId) {
    return { valid: false, error: 'You cannot use your own referral code' };
  }

  if (referralCode.usedBy?.includes(forUserId)) {
    return { valid: false, error: 'You have already used this code' };
  }

  if (referralCode.restrictedTo && forPurpose && referralCode.restrictedTo !== forPurpose) {
    return { valid: false, error: 'This code cannot be used for this purchase' };
  }

  return { valid: true, referralCode };
}

// Mark referral code as used
export async function redeemReferralCode(
  kv: KVNamespace,
  code: string,
  usedByUserId: string
): Promise<{ success: boolean; error?: string }> {
  const referralCode = await getReferralCode(kv, code);

  if (!referralCode) {
    return { success: false, error: 'Invalid code' };
  }

  // Update the code
  referralCode.usedCount += 1;
  referralCode.usedBy = referralCode.usedBy || [];
  referralCode.usedBy.push(usedByUserId);

  // If max uses reached, deactivate
  if (referralCode.usedCount >= referralCode.maxUses) {
    referralCode.active = false;
  }

  // Save updated code
  await kv.put(
    KV_KEYS.byCode(referralCode.code),
    JSON.stringify(referralCode),
    { expirationTtl: 365 * 24 * 60 * 60 }
  );

  return { success: true };
}
