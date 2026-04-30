// src/pages/api/admin/backfill-mix-og.ts
// One-time admin endpoint — generates Facebook OG (1200x630) variants for
// existing mixes whose docs don't yet have `ogImageUrl`. Intended to be
// called repeatedly (e.g. from scripts/backfill-mix-og.cjs) until the
// `processed` count comes back as 0.
//
// POST body (all optional):
//   { mixId?: string, limit?: number, dryRun?: boolean }
//
// - mixId: process this specific mix only (skips the listing step)
// - limit: max number of mixes to process per call (default 3, max 5)
// - dryRun: list candidates without uploading or writing back
//
// Response: { processed, candidates, results: [{ mixId, ok, error?, sizeKB? }] }
import type { APIRoute } from 'astro';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, createLogger, successResponse, getR2Config } from '../../../lib/api-utils';
import { createS3Client } from '../../../lib/s3-client';
import { getDocument, queryCollection, setDocument, invalidateMixesCache } from '../../../lib/firebase-rest';
import { d1UpsertMix } from '../../../lib/d1-catalog';
import { initKVCache, invalidateMixesKVCache } from '../../../lib/kv-cache';
import { processImageToFacebookOG, imageContentType, imageExtension } from '../../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('backfill-mix-og');

const BodySchema = z.object({
  mixId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5).optional().default(3),
  dryRun: z.boolean().optional().default(false),
});

type Result = { mixId: string; ok: boolean; error?: string; sizeKB?: number };

async function processOne(
  mixId: string,
  s3Client: ReturnType<typeof createS3Client>,
  bucket: string,
  publicDomain: string,
  dryRun: boolean,
  db: D1Database | undefined
): Promise<Result> {
  const doc = await getDocument('dj-mixes', mixId);
  if (!doc) return { mixId, ok: false, error: 'Mix not found' };
  if (doc.ogImageUrl) return { mixId, ok: true, error: 'Already has ogImageUrl' };

  const artworkUrl = doc.artworkUrl || doc.artwork_url;
  if (!artworkUrl || artworkUrl === '/place-holder.webp') {
    return { mixId, ok: false, error: 'No artwork to process' };
  }

  // Extract R2 key from public URL: <publicDomain>/<key>
  const prefix = publicDomain.endsWith('/') ? publicDomain : publicDomain + '/';
  if (!artworkUrl.startsWith(prefix)) {
    return { mixId, ok: false, error: `Artwork URL outside R2 (${artworkUrl})` };
  }
  const artworkKey = artworkUrl.slice(prefix.length);
  const folderPath = artworkKey.includes('/') ? artworkKey.slice(0, artworkKey.lastIndexOf('/')) : '';

  // Fetch existing artwork from R2
  const getRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: artworkKey }));
  const body = getRes.Body;
  if (!body) return { mixId, ok: false, error: 'Empty artwork body from R2' };

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
    return { mixId, ok: true, sizeKB: Math.round(artworkBuffer.length / 1024) };
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
  await setDocument('dj-mixes', mixId, updatedDoc);

  // Mirror to D1 — the dj-mix page reads from D1 first so without this update
  // the OG meta tag keeps emitting the square artwork URL.
  if (db) {
    try {
      await d1UpsertMix(db, mixId, updatedDoc);
    } catch (e: unknown) {
      log.warn(`[backfill-mix-og] D1 upsert failed for ${mixId} (non-critical):`, e);
    }
  }

  return { mixId, ok: true, sizeKB: Math.round(ogImg.buffer.length / 1024) };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`backfill-mix-og:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const rawBody = await request.clone().json().catch(() => ({}));
  const authError = await requireAdminAuth(request, locals, rawBody);
  if (authError) return authError;

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) return ApiErrors.badRequest('Invalid request body');
  const { mixId, limit, dryRun } = parsed.data;

  const env = locals.runtime.env;
  const r2Config = getR2Config(env);
  if (!r2Config) return ApiErrors.serverError('R2 config missing');
  const s3Client = createS3Client(r2Config);
  const db = env?.DB;

  // Single-mix mode
  if (mixId) {
    const result = await processOne(mixId, s3Client, r2Config.bucketName, r2Config.publicDomain, dryRun, db)
      .catch((e: unknown) => ({ mixId, ok: false, error: String(e) } as Result));
    if (!dryRun && result.ok) {
      invalidateMixesCache();
      try { initKVCache(env); await invalidateMixesKVCache(); } catch { /* non-critical */ }
    }
    log.info(`[backfill-mix-og] single result:`, result);
    return successResponse({ processed: result.ok ? 1 : 0, candidates: 1, results: [result] });
  }

  // Batch mode — find mixes without ogImageUrl
  // queryCollection doesn't support "field absent" filters, so scan a window
  // and filter client-side. With ~hundreds of mixes this is fine.
  const allMixes = await queryCollection('dj-mixes', [], undefined, 1000) as Array<Record<string, unknown> & { id: string }>;
  const candidates = allMixes
    .filter((m) => !m.ogImageUrl && (m.artworkUrl || m.artwork_url) && (m.artworkUrl !== '/place-holder.webp'))
    .slice(0, limit);

  if (candidates.length === 0) {
    return successResponse({ processed: 0, candidates: 0, results: [], message: 'Nothing left to backfill' });
  }

  const results: Result[] = [];
  for (const mix of candidates) {
    try {
      const r = await processOne(mix.id, s3Client, r2Config.bucketName, r2Config.publicDomain, dryRun, db);
      results.push(r);
    } catch (e: unknown) {
      results.push({ mixId: mix.id, ok: false, error: String(e) });
    }
  }

  if (!dryRun && results.some((r) => r.ok)) {
    invalidateMixesCache();
    try { initKVCache(env); await invalidateMixesKVCache(); } catch { /* non-critical */ }
  }

  log.info(`[backfill-mix-og] batch ${results.length} results, ${results.filter(r => r.ok).length} ok`);
  return successResponse({ processed: results.filter((r) => r.ok).length, candidates: candidates.length, results });
};
