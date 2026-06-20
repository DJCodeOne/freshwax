// src/pages/api/admin/backfill-release-og.ts
// One-time admin endpoint — generates Facebook OG (1200x630) variants for
// existing releases whose docs don't yet have `ogImageUrl`. Square cover art
// gets cropped top + bottom by Facebook's 1.91:1 link card; this produces a
// 1200x630 card (square art centered on a blurred fill) so shares look right.
//
// Intended to be called repeatedly (e.g. from scripts/backfill-release-og.cjs)
// until the `candidates` count comes back as 0.
//
// POST body (all optional):
//   { releaseId?: string, limit?: number, dryRun?: boolean }
//
// Response: { processed, candidates, results: [{ releaseId, ok, error?, sizeKB? }] }
import type { APIRoute } from 'astro';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, createLogger, successResponse, getR2Config } from '../../../lib/api-utils';
import { createS3Client } from '../../../lib/s3-client';
import { getDocument, queryCollection, setDocument, invalidateReleasesCache } from '../../../lib/firebase-rest';
import { d1UpsertRelease } from '../../../lib/d1-catalog';
import { initKVCache, invalidateReleasesKVCache } from '../../../lib/kv-cache';
import { processImageToFacebookOG, imageContentType, imageExtension } from '../../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('backfill-release-og');

const BodySchema = z.object({
  releaseId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5).optional().default(3),
  dryRun: z.boolean().optional().default(false),
});

type Result = { releaseId: string; ok: boolean; error?: string; sizeKB?: number };

async function processOne(
  releaseId: string,
  s3Client: ReturnType<typeof createS3Client>,
  bucket: string,
  publicDomain: string,
  dryRun: boolean,
  db: D1Database | undefined
): Promise<Result> {
  const doc = await getDocument('releases', releaseId);
  if (!doc) return { releaseId, ok: false, error: 'Release not found' };
  if (doc.ogImageUrl) return { releaseId, ok: true, error: 'Already has ogImageUrl' };

  // Prefer the highest-quality square source available.
  const sourceUrl = (doc.originalArtworkUrl || doc.coverArtUrl || doc.coverArt) as string | undefined;
  if (!sourceUrl || sourceUrl === '/place-holder.webp') {
    return { releaseId, ok: false, error: 'No artwork to process' };
  }

  // Extract R2 key from public URL: <publicDomain>/<key>
  const prefix = publicDomain.endsWith('/') ? publicDomain : publicDomain + '/';
  if (!sourceUrl.startsWith(prefix)) {
    return { releaseId, ok: false, error: `Artwork URL outside R2 (${sourceUrl})` };
  }
  const sourceKey = sourceUrl.slice(prefix.length);
  const folderPath = sourceKey.includes('/') ? sourceKey.slice(0, sourceKey.lastIndexOf('/')) : '';

  // Fetch existing artwork from R2
  const getRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
  const body = getRes.Body;
  if (!body) return { releaseId, ok: false, error: 'Empty artwork body from R2' };

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  // @ts-expect-error — Body is a Web ReadableStream in Workers
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const artworkBuffer = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { artworkBuffer.set(c, off); off += c.length; }

  if (dryRun) {
    return { releaseId, ok: true, sizeKB: Math.round(artworkBuffer.length / 1024) };
  }

  const ogImg = await processImageToFacebookOG(artworkBuffer.buffer as ArrayBuffer, 78);
  const ogKey = `${folderPath}/og${imageExtension(ogImg.format)}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: ogKey,
    Body: Buffer.from(ogImg.buffer),
    ContentType: imageContentType(ogImg.format),
    CacheControl: 'public, max-age=31536000',
  }));

  const ogImageUrl = `${publicDomain}/${ogKey}`;
  const updatedDoc = { ...doc, ogImageUrl, updatedAt: new Date().toISOString() };
  await setDocument('releases', releaseId, updatedDoc);

  // Mirror to D1 — the item page reads releases_v2 first, so without this the OG
  // meta tag would keep emitting the square cover URL.
  if (db) {
    try {
      await d1UpsertRelease(db, releaseId, updatedDoc);
    } catch (e: unknown) {
      log.warn(`[backfill-release-og] D1 upsert failed for ${releaseId} (non-critical):`, e);
    }
  }

  return { releaseId, ok: true, sizeKB: Math.round(ogImg.buffer.length / 1024) };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`backfill-release-og:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const rawBody = await request.clone().json().catch(() => ({}));
  const authError = await requireAdminAuth(request, locals, rawBody);
  if (authError) return authError;

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) return ApiErrors.badRequest('Invalid request body');
  const { releaseId, limit, dryRun } = parsed.data;

  const env = locals.runtime.env;
  const r2Config = getR2Config(env);
  if (!r2Config) return ApiErrors.serverError('R2 config missing');
  const s3Client = createS3Client(r2Config);
  const db = env?.DB;

  // Single-release mode
  if (releaseId) {
    const result = await processOne(releaseId, s3Client, r2Config.bucketName, r2Config.publicDomain, dryRun, db)
      .catch((e: unknown) => ({ releaseId, ok: false, error: String(e) } as Result));
    if (!dryRun && result.ok) {
      invalidateReleasesCache();
      try { initKVCache(env); await invalidateReleasesKVCache(); } catch { /* non-critical */ }
    }
    log.info(`[backfill-release-og] single result:`, result);
    return successResponse({ processed: result.ok ? 1 : 0, candidates: 1, results: [result] });
  }

  // Batch mode — find releases without ogImageUrl.
  // queryCollection doesn't support "field absent" filters, so scan a window
  // and filter client-side.
  const allReleases = await queryCollection('releases', [], undefined, 1000) as Array<Record<string, unknown> & { id: string }>;
  const candidates = allReleases
    .filter((r) => !r.ogImageUrl && (r.originalArtworkUrl || r.coverArtUrl || r.coverArt) && (r.coverArtUrl !== '/place-holder.webp'))
    .slice(0, limit);

  if (candidates.length === 0) {
    return successResponse({ processed: 0, candidates: 0, results: [], message: 'Nothing left to backfill' });
  }

  const results: Result[] = [];
  for (const rel of candidates) {
    try {
      const r = await processOne(rel.id, s3Client, r2Config.bucketName, r2Config.publicDomain, dryRun, db);
      results.push(r);
    } catch (e: unknown) {
      results.push({ releaseId: rel.id, ok: false, error: String(e) });
    }
  }

  if (!dryRun && results.some((r) => r.ok)) {
    invalidateReleasesCache();
    try { initKVCache(env); await invalidateReleasesKVCache(); } catch { /* non-critical */ }
  }

  log.info(`[backfill-release-og] batch ${results.length} results, ${results.filter(r => r.ok).length} ok`);
  return successResponse({ processed: results.filter((r) => r.ok).length, candidates: candidates.length, results });
};
