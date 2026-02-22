// src/pages/api/cron/image-scan.ts
// Cron: 0 4 * * * (daily at 04:00 UTC)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to scan R2 for non-WebP images that need conversion.
// Scans key prefixes: releases/, merch/, dj-mixes/, vinyl/
// Logs findings to D1 — does NOT auto-convert (admin triggers reprocess manually).

import type { APIRoute } from 'astro';
import { ApiErrors, createLogger, timingSafeCompare, successResponse } from '../../../lib/api-utils';

const log = createLogger('[image-scan]');

export const prerender = false;

const SCAN_PREFIXES = ['releases/', 'merch/', 'dj-mixes/', 'vinyl/'];
const NON_WEBP = /\.(jpg|jpeg|png|gif)$/i;
const MAX_OBJECTS_PER_RUN = 500;

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  log.info('[Image Scan] ========== CRON JOB STARTED ==========');

  const env = locals.runtime.env;

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isAuthorized =
    (cronSecret && token && timingSafeCompare(token, cronSecret)) ||
    (adminKey && xAdminKey && timingSafeCompare(xAdminKey, adminKey));

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  const r2: R2Bucket | undefined = env?.R2;
  const db: D1Database | undefined = env?.DB;

  if (!r2) {
    log.error('[Image Scan] R2 binding not available');
    return ApiErrors.serverError('R2 binding not configured');
  }

  try {
    // Ensure D1 table exists for logging results
    if (db) {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS image_scan_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scan_date TEXT NOT NULL,
          key TEXT NOT NULL,
          size INTEGER NOT NULL,
          prefix TEXT NOT NULL,
          webp_exists INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();
    }

    const scanDate = new Date().toISOString();
    let totalScanned = 0;
    let totalNonWebp = 0;
    let totalSkipped = 0;
    const issues: Array<{ key: string; size: number; prefix: string }> = [];

    for (const prefix of SCAN_PREFIXES) {
      if (totalScanned >= MAX_OBJECTS_PER_RUN) break;

      const remaining = MAX_OBJECTS_PER_RUN - totalScanned;
      let cursor: string | undefined;
      let prefixDone = false;

      while (!prefixDone && totalScanned < MAX_OBJECTS_PER_RUN) {
        const listResult = await r2.list({
          prefix,
          limit: Math.min(remaining, 1000),
          cursor,
        });

        for (const obj of listResult.objects) {
          totalScanned++;

          // Only check non-WebP image files
          if (!NON_WEBP.test(obj.key)) continue;

          // Check if a .webp version already exists at the same path
          const webpKey = obj.key.replace(NON_WEBP, '.webp');
          const webpHead = await r2.head(webpKey);

          if (webpHead) {
            // WebP version exists, skip
            totalSkipped++;
            continue;
          }

          // This image needs conversion
          totalNonWebp++;
          issues.push({
            key: obj.key,
            size: obj.size,
            prefix,
          });
        }

        // Handle pagination
        if (listResult.truncated && listResult.cursor) {
          cursor = listResult.cursor;
        } else {
          prefixDone = true;
        }
      }
    }

    // Log results to D1
    if (db) {
      // Clear old results (>30 days) and today's previous run to prevent accumulation
      const today = scanDate.split('T')[0]; // YYYY-MM-DD
      await db.batch([
        db.prepare(`DELETE FROM image_scan_results WHERE scan_date < datetime('now', '-30 days')`),
        db.prepare(`DELETE FROM image_scan_results WHERE scan_date >= ? AND scan_date < ?`).bind(today + 'T00:00:00', today + 'T23:59:59'),
      ]);

      if (issues.length > 0) {
        // Batch insert — D1 supports batch operations
        const insertStmt = db.prepare(
          `INSERT INTO image_scan_results (scan_date, key, size, prefix, webp_exists) VALUES (?, ?, ?, ?, 0)`
        );

        const batchSize = 50;
        for (let i = 0; i < issues.length; i += batchSize) {
          const batch = issues.slice(i, i + batchSize);
          await db.batch(
            batch.map(issue => insertStmt.bind(scanDate, issue.key, issue.size, issue.prefix))
          );
        }

        log.info(`[Image Scan] Logged ${issues.length} issues to D1`);
      }
    }

    const duration = Date.now() - startTime;
    log.info('[Image Scan] ========== COMPLETED ==========');
    log.info(`[Image Scan] Duration: ${duration}ms`);
    log.info(`[Image Scan] Scanned: ${totalScanned}, Non-WebP: ${totalNonWebp}, Skipped (WebP exists): ${totalSkipped}`);

    return successResponse({ duration,
      scanned: totalScanned,
      nonWebpFound: totalNonWebp,
      skippedWebpExists: totalSkipped,
      issues: issues.slice(0, 100), // Return first 100 in response
      totalIssues: issues.length,
      prefixesScanned: SCAN_PREFIXES,
      scanDate, });

  } catch (error: unknown) {
    log.error('[Image Scan] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// Support GET for manual triggering from admin panel
export const GET: APIRoute = async (context) => POST(context);
