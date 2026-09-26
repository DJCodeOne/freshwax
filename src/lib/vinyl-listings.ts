// src/lib/vinyl-listings.ts
// Shared rules for Crates (vinyl marketplace) listings.
//
// Firestore `vinylListings` is the single source of truth for listings: the
// seller dashboard (/api/vinyl/listing), admin approve/reject, order
// processing (reserve / sold / refund), checkout validation, the Crates index
// (/api/vinyl/public) and the sitemap all read and write it. The listing page
// used to read a D1 copy through the separate vinyl-api worker instead, and
// that copy only changed when an admin ran /api/admin/sync-vinyl-to-d1 — so a
// seller's edits, a sale or a removal never reached the page (Sep 2026). The
// page now reads Firestore through getPublicVinylListing, so there is nothing
// to keep in sync.

import { saGetDocument, getServiceAccountKey } from './firebase-service-account';
import { createLogger } from './api-utils';

const log = createLogger('vinyl-listings');

/**
 * Statuses a buyer may see. Live listings can be bought; sold and reserved ones
 * stay visible but unavailable. draft, pending, rejected and removed listings
 * are Not Found.
 */
export const PUBLIC_LISTING_STATUSES = ['published', 'sold', 'reserved'] as const;

export function isPublicListingStatus(status: unknown): boolean {
  return typeof status === 'string' && (PUBLIC_LISTING_STATUSES as readonly string[]).includes(status);
}

/**
 * A listing anyone may read: a public status and not soft-deleted. Drafts,
 * pending, rejected and removed listings are private to their seller.
 */
export function isPublicListing(listing: Record<string, unknown> | null | undefined): boolean {
  return !!listing && listing.deleted !== true && isPublicListingStatus(listing.status);
}

/** A listing a buyer can currently add to their bag. */
export function isPurchasableListing(listing: Record<string, unknown> | null | undefined): boolean {
  return !!listing && listing.status === 'published' && listing.deleted !== true;
}

/**
 * Read one listing from Firestore for public display, or null when it doesn't
 * exist, is soft-deleted, or isn't in a public status. Errors are logged and
 * treated as not found.
 */
export async function getPublicVinylListing(
  env: Record<string, unknown> | undefined,
  listingId: string | undefined | null
): Promise<Record<string, unknown> | null> {
  if (!env || !listingId) return null;
  const serviceAccountKey = getServiceAccountKey(env);
  if (!serviceAccountKey) {
    log.error('Service account not configured — cannot read vinyl listing');
    return null;
  }
  const projectId = (env.FIREBASE_PROJECT_ID as string | undefined) || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  try {
    const listing = await saGetDocument(serviceAccountKey, projectId, 'vinylListings', listingId);
    return isPublicListing(listing) ? listing : null;
  } catch (error: unknown) {
    log.error(`Failed to read vinyl listing ${listingId}:`, error);
    return null;
  }
}

const MAX_IMAGE_URL_LENGTH = 500;
// https URLs or site-root paths ("/place-holder.webp"); never protocol-relative,
// and no whitespace, quotes, angle brackets or backticks.
const SAFE_IMAGE_URL = /^(https:\/\/[^\s"'<>`]+|\/(?!\/)[^\s"'<>`]*)$/i;

/**
 * Listing images come straight from the seller's request body. Keep only safe
 * URL strings: the listing page renders them into HTML, so an unchecked value
 * could inject markup into a public page.
 */
export function sanitizeListingImages(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((url): url is string => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url.length > 0 && url.length <= MAX_IMAGE_URL_LENGTH && SAFE_IMAGE_URL.test(url))
    .slice(0, max);
}
