// src/pages/api/admin/backfill-merch-og.ts
// One-time admin endpoint — generates Facebook OG (1200x630) variants for
// existing merch whose docs don't yet have `ogImageUrl`. Square product photos
// get cropped top + bottom by Facebook's 1.91:1 link card; this produces a
// 1200x630 card (square photo centered on a blurred fill) so shares look right.
//
// Intended to be called repeatedly (e.g. from scripts/backfill-merch-og.cjs)
// until the `candidates` count comes back as 0.
//
// POST body (all optional): { productId?: string, limit?: number, dryRun?: boolean }
// Response: { processed, candidates, results: [{ productId, ok, error?, sizeKB? }] }
import type { APIRoute } from 'astro';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, createLogger, successResponse, getR2Config } from '../../../lib/api-utils';
import { createS3Client } from '../../../lib/s3-client';
import { getDocument, queryCollection, setDocument, clearAllMerchCache } from '../../../lib/firebase-rest';
import { d1UpsertMerch } from '../../../lib/d1-catalog';
import { kvDelete, CACHE_CONFIG } from '../../../lib/kv-cache';
import { processImageToFacebookOG, imageContentType, imageExtension } from '../../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('backfill-merch-og');

const BodySchema = z.object({
  productId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5).optional().default(3),
  dryRun: z.boolean().optional().default(false),
});

type Result = { productId: string; ok: boolean; error?: string; sizeKB?: number };

function primaryImageOf(doc: Record<string, unknown>): string {
  if (doc.primaryImage) return doc.primaryImage as string;
  if (doc.imageUrl) return doc.imageUrl as string;
  const imgs = doc.images;
  if (Array.isArray(imgs) && imgs.length) {
    const first = imgs[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && (first as Record<string, unknown>).url) return (first as Record<string, unknown>).url as string;
  }
  return '';
}

async function processOne(
  productId: string,
  s3Client: ReturnType<typeof createS3Client>,
  bucket: string,
  publicDomain: string,
  dryRun: boolean,
  db: D1Database | undefined
): Promise<Result> {
  const doc = await getDocument('merch', productId);
  if (!doc) return { productId, ok: false, error: 'Merch not found' };
  if (doc.ogImageUrl) return { productId, ok: true, error: 'Already has ogImageUrl' };

  const sourceUrl = primaryImageOf(doc);
  if (!sourceUrl || sourceUrl === '/place-holder.webp') {
    return { productId, ok: false, error: 'No image to process' };
  }

  const prefix = publicDomain.endsWith('/') ? publicDomain : publicDomain + '/';
  if (!sourceUrl.startsWith(prefix)) {
    return { productId, ok: false, error: `Image URL outside R2 (${sourceUrl})` };
  }
  // Decode percent-encoding (e.g. %20) — the R2 key is the decoded path.
  let sourceKey = sourceUrl.slice(prefix.length);
  try { sourceKey = decodeURIComponent(sourceKey); } catch { /* keep as-is if malformed */ }
  const folderPath = sourceKey.includes('/') ? sourceKey.slice(0, sourceKey.lastIndexOf('/')) : '';

  const getRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
  const body = getRes.Body;
  if (!body) return { productId, ok: false, error: 'Empty image body from R2' };

  const chunks: Uint8Array[] = [];
  // @ts-expect-error — Body is a Web ReadableStream in Workers
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }

  if (dryRun) {
    return { productId, ok: true, sizeKB: Math.round(buf.length / 1024) };
  }

  const ogImg = await processImageToFacebookOG(buf.buffer as ArrayBuffer, 78);
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
  await setDocument('merch', productId, updatedDoc);

  if (db) {
    try {
      await d1UpsertMerch(db, productId, updatedDoc);
    } catch (e: unknown) {
      log.warn(`[backfill-merch-og] D1 upsert failed for ${productId} (non-critical):`, e);
    }
  }

  return { productId, ok: true, sizeKB: Math.round(ogImg.buffer.length / 1024) };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`backfill-merch-og:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const rawBody = await request.clone().json().catch(() => ({}));
  const authError = await requireAdminAuth(request, locals, rawBody);
  if (authError) return authError;

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) return ApiErrors.badRequest('Invalid request body');
  const { productId, limit, dryRun } = parsed.data;

  const env = locals.runtime.env;
  const r2Config = getR2Config(env);
  if (!r2Config) return ApiErrors.serverError('R2 config missing');
  const s3Client = createS3Client(r2Config);
  const db = env?.DB;

  const invalidate = async () => {
    clearAllMerchCache();
    try { await kvDelete('live-merch-v2:all', CACHE_CONFIG.MERCH); } catch { /* non-critical */ }
  };

  if (productId) {
    const result = await processOne(productId, s3Client, r2Config.bucketName, r2Config.publicDomain, dryRun, db)
      .catch((e: unknown) => ({ productId, ok: false, error: String(e) } as Result));
    if (!dryRun && result.ok) await invalidate();
    log.info(`[backfill-merch-og] single result:`, result);
    return successResponse({ processed: result.ok ? 1 : 0, candidates: 1, results: [result] });
  }

  const allMerch = await queryCollection('merch', [], undefined, 1000) as Array<Record<string, unknown> & { id: string }>;
  const candidates = allMerch
    .filter((m) => !m.ogImageUrl && primaryImageOf(m) && primaryImageOf(m) !== '/place-holder.webp')
    .slice(0, limit);

  if (candidates.length === 0) {
    return successResponse({ processed: 0, candidates: 0, results: [], message: 'Nothing left to backfill' });
  }

  const results: Result[] = [];
  for (const m of candidates) {
    try {
      const r = await processOne(m.id, s3Client, r2Config.bucketName, r2Config.publicDomain, dryRun, db);
      results.push(r);
    } catch (e: unknown) {
      results.push({ productId: m.id, ok: false, error: String(e) });
    }
  }

  if (!dryRun && results.some((r) => r.ok)) await invalidate();

  log.info(`[backfill-merch-og] batch ${results.length} results, ${results.filter(r => r.ok).length} ok`);
  return successResponse({ processed: results.filter((r) => r.ok).length, candidates: candidates.length, results });
};
