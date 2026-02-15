// src/pages/api/admin/r2-image-sync.ts
// Sync reprocessed R2 image URLs back to Firestore documents
// POST /api/admin/r2-image-sync/

import '../../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { initFirebaseEnv, getDocument, updateDocument } from '../../../lib/firebase-rest';
import { createLogger, successResponse, errorResponse, ApiErrors, parseJsonBody } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('r2-image-sync');

interface SyncRequest {
  results: Array<{
    key: string;
    newKey: string;
    status: 'success' | 'failed';
    thumbKey?: string;
  }>;
}

interface SyncDetail {
  key: string;
  collection: string;
  docId: string;
  status: 'synced' | 'skipped' | 'failed';
  updatedFields?: string[];
  error?: string;
}

// Map R2 prefix to Firestore collection name
const PREFIX_TO_COLLECTION: Record<string, string> = {
  'releases': 'releases',
  'dj-mixes': 'dj-mixes',
  'merch': 'merch',
  'vinyl': 'vinyl-listings',
};

/**
 * Parse an R2 key to extract the collection type and document ID.
 * Keys follow the pattern: prefix/docId/filename
 * e.g. "releases/abc123/cover.jpg" -> { prefix: "releases", docId: "abc123" }
 */
function parseR2Key(key: string): { prefix: string; docId: string; filename: string } | null {
  const parts = key.split('/');
  if (parts.length < 3) return null;

  const prefix = parts[0];
  const docId = parts[1];
  const filename = parts.slice(2).join('/');

  if (!prefix || !docId || !filename) return null;
  return { prefix, docId, filename };
}

/**
 * Build a full public URL from an R2 key.
 */
function buildUrl(publicDomain: string, key: string): string {
  // Ensure domain doesn't end with slash and key doesn't start with slash
  const domain = publicDomain.replace(/\/+$/, '');
  const cleanKey = key.replace(/^\/+/, '');
  return `${domain}/${cleanKey}`;
}

/**
 * Determine which Firestore fields to update based on the R2 key filename and existing document fields.
 */
function buildFieldUpdates(
  parsed: { prefix: string; docId: string; filename: string },
  newKey: string,
  thumbKey: string | undefined,
  publicDomain: string,
  existingDoc: Record<string, any>,
): Record<string, any> {
  const updates: Record<string, any> = {};
  const newUrl = buildUrl(publicDomain, newKey);
  const lowerFilename = parsed.filename.toLowerCase();

  if (parsed.prefix === 'releases') {
    // Cover image: cover.webp, cover.jpg, cover.png, etc.
    if (lowerFilename.startsWith('cover') || lowerFilename.startsWith('artwork')) {
      if ('coverUrl' in existingDoc) updates.coverUrl = newUrl;
      if ('imageUrl' in existingDoc) updates.imageUrl = newUrl;
      if ('artworkUrl' in existingDoc) updates.artworkUrl = newUrl;
      if ('coverArtUrl' in existingDoc) updates.coverArtUrl = newUrl;
    }

    // Thumb image
    if (lowerFilename.startsWith('thumb')) {
      if ('thumbUrl' in existingDoc) updates.thumbUrl = newUrl;
    }

    // If a thumb was also generated during reprocess, update thumbUrl
    if (thumbKey && 'thumbUrl' in existingDoc) {
      updates.thumbUrl = buildUrl(publicDomain, thumbKey);
    }

  } else if (parsed.prefix === 'dj-mixes') {
    if ('artworkUrl' in existingDoc) updates.artworkUrl = newUrl;
    if ('imageUrl' in existingDoc) updates.imageUrl = newUrl;
    if ('coverArtUrl' in existingDoc) updates.coverArtUrl = newUrl;

  } else if (parsed.prefix === 'merch') {
    // Single main image
    if (lowerFilename.startsWith('cover') || lowerFilename.startsWith('image') || lowerFilename.startsWith('main')) {
      if ('imageUrl' in existingDoc) updates.imageUrl = newUrl;
    }

    // Update images[] array entries if the doc has one
    if (Array.isArray(existingDoc.images)) {
      const oldUrl = buildUrl(publicDomain, parsed.prefix + '/' + parsed.docId + '/' + parsed.filename);
      const updatedImages = existingDoc.images.map((img: any) => {
        if (typeof img === 'string') {
          // Check if the old URL matches by comparing the path segment
          const imgPath = img.replace(/^https?:\/\/[^/]+\//, '');
          const originalKeyBase = (parsed.prefix + '/' + parsed.docId + '/' + parsed.filename).replace(/\.[^.]+$/, '');
          if (imgPath.replace(/\.[^.]+$/, '') === originalKeyBase) {
            return newUrl;
          }
          return img;
        }
        // If images are objects with a url field
        if (typeof img === 'object' && img !== null && img.url) {
          const imgPath = img.url.replace(/^https?:\/\/[^/]+\//, '');
          const originalKeyBase = (parsed.prefix + '/' + parsed.docId + '/' + parsed.filename).replace(/\.[^.]+$/, '');
          if (imgPath.replace(/\.[^.]+$/, '') === originalKeyBase) {
            return { ...img, url: newUrl };
          }
        }
        return img;
      });

      // Only update if something changed
      if (JSON.stringify(updatedImages) !== JSON.stringify(existingDoc.images)) {
        updates.images = updatedImages;
      }
    }

  } else if (parsed.prefix === 'vinyl') {
    // Vinyl uses images[] array
    if (Array.isArray(existingDoc.images)) {
      const updatedImages = existingDoc.images.map((img: any) => {
        if (typeof img === 'string') {
          const imgPath = img.replace(/^https?:\/\/[^/]+\//, '');
          const originalKeyBase = (parsed.prefix + '/' + parsed.docId + '/' + parsed.filename).replace(/\.[^.]+$/, '');
          if (imgPath.replace(/\.[^.]+$/, '') === originalKeyBase) {
            return newUrl;
          }
          return img;
        }
        if (typeof img === 'object' && img !== null && img.url) {
          const imgPath = img.url.replace(/^https?:\/\/[^/]+\//, '');
          const originalKeyBase = (parsed.prefix + '/' + parsed.docId + '/' + parsed.filename).replace(/\.[^.]+$/, '');
          if (imgPath.replace(/\.[^.]+$/, '') === originalKeyBase) {
            return { ...img, url: newUrl };
          }
        }
        return img;
      });

      if (JSON.stringify(updatedImages) !== JSON.stringify(existingDoc.images)) {
        updates.images = updatedImages;
      }
    }

    // Also check for top-level imageUrl
    if ('imageUrl' in existingDoc) updates.imageUrl = newUrl;
  }

  return updates;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await parseJsonBody<SyncRequest>(request);
  if (!body) return ApiErrors.badRequest('Invalid JSON body');

  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const rateCheck = checkRateLimit(`r2-sync:${getClientId(request)}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const { results } = body;

  if (!Array.isArray(results) || results.length === 0) {
    return ApiErrors.badRequest('results must be a non-empty array');
  }

  // Initialize Firebase env for server-side calls
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY,
  });

  const publicDomain = env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk';

  let synced = 0;
  let failed = 0;
  const details: SyncDetail[] = [];

  // Only process successful results
  const successfulResults = results.filter(r => r.status === 'success' && r.newKey);

  for (const result of successfulResults) {
    const parsed = parseR2Key(result.key);
    if (!parsed) {
      details.push({
        key: result.key,
        collection: 'unknown',
        docId: 'unknown',
        status: 'skipped',
        error: 'Could not parse R2 key',
      });
      continue;
    }

    const collection = PREFIX_TO_COLLECTION[parsed.prefix];
    if (!collection) {
      details.push({
        key: result.key,
        collection: parsed.prefix,
        docId: parsed.docId,
        status: 'skipped',
        error: `Unknown collection prefix: ${parsed.prefix}`,
      });
      continue;
    }

    try {
      // Fetch current document to check which fields exist
      const doc = await getDocument(collection, parsed.docId);
      if (!doc) {
        details.push({
          key: result.key,
          collection,
          docId: parsed.docId,
          status: 'skipped',
          error: 'Document not found in Firestore',
        });
        continue;
      }

      // Build field updates
      const updates = buildFieldUpdates(parsed, result.newKey, result.thumbKey, publicDomain, doc);

      if (Object.keys(updates).length === 0) {
        details.push({
          key: result.key,
          collection,
          docId: parsed.docId,
          status: 'skipped',
          error: 'No matching fields to update',
        });
        continue;
      }

      // Update Firestore document (handles cache invalidation automatically)
      await updateDocument(collection, parsed.docId, updates);

      const updatedFields = Object.keys(updates);
      log.info(`Synced ${result.key} -> ${collection}/${parsed.docId}: ${updatedFields.join(', ')}`);
      synced++;
      details.push({
        key: result.key,
        collection,
        docId: parsed.docId,
        status: 'synced',
        updatedFields,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to sync ${result.key}:`, err);
      failed++;
      details.push({
        key: result.key,
        collection,
        docId: parsed.docId,
        status: 'failed',
        error: message,
      });
    }
  }

  return successResponse({ synced, failed, skipped: details.filter(d => d.status === 'skipped').length, details });
};
