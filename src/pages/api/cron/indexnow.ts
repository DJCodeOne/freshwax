// src/pages/api/cron/indexnow.ts
// IndexNow submitter: diffs the live sitemap against the last-seen snapshot
// (KV) and pushes new/changed URLs to api.indexnow.org so Bing/Yandex/etc.
// pick up content changes within minutes instead of waiting for a crawl.
//
// Trigger: chained from the daily backup-d1 cron (no separate schedule
// needed); also callable manually with the same bearer secret. First run
// submits the full sitemap as the initial seed.
//
// Key: f299fb635350b61970ee0dd03b2c22d2 — hosted at /<key>.txt (public/),
// which is how IndexNow verifies domain ownership.

import type { APIRoute } from 'astro';
import { initKVCache, kvGet, kvSet } from '../../../lib/kv-cache';
import { createLogger, errorResponse, successResponse, fetchWithTimeout, timingSafeCompare } from '../../../lib/api-utils';
import { SITE_URL } from '../../../lib/constants';
import { TIMEOUTS } from '../../../lib/timeouts';

const log = createLogger('[cron/indexnow]');

export const prerender = false;

const INDEXNOW_KEY = 'f299fb635350b61970ee0dd03b2c22d2';
const KV_SNAPSHOT = 'indexnow:sitemap-snapshot';
const MAX_URLS_PER_SUBMIT = 10000; // IndexNow protocol limit

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;

  // Same auth as the other cron endpoints: Authorization: Bearer $CRON_SECRET
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  if (!secret || !bearer || !timingSafeCompare(bearer, secret)) {
    return errorResponse('Unauthorized', 403);
  }

  initKVCache(env);

  try {
    // Pull the live sitemap and extract url -> lastmod
    const res = await fetchWithTimeout(`${SITE_URL}/sitemap.xml`, {}, TIMEOUTS.API_EXTENDED);
    if (!res.ok) return errorResponse(`Sitemap fetch failed: ${res.status}`, 502);
    const xml = await res.text();

    const current: Record<string, string> = {};
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
    for (const block of urlBlocks) {
      const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
      const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] || '';
      if (loc) current[loc] = lastmod;
    }
    const total = Object.keys(current).length;
    if (total === 0) return errorResponse('Sitemap parsed to zero URLs — refusing to diff', 502);

    // Diff against the previous snapshot; first run submits everything
    const previous = (await kvGet<Record<string, string>>(KV_SNAPSHOT)) || null;
    const changed = previous
      ? Object.keys(current).filter((u) => previous[u] === undefined || previous[u] !== current[u])
      : Object.keys(current);

    if (changed.length === 0) {
      log.info('No sitemap changes — nothing to submit');
      return successResponse({ submitted: 0, total, firstRun: false });
    }

    const body = {
      host: new URL(SITE_URL).host,
      key: INDEXNOW_KEY,
      keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
      urlList: changed.slice(0, MAX_URLS_PER_SUBMIT),
    };

    const submit = await fetchWithTimeout('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    }, TIMEOUTS.API_EXTENDED);

    // 200 = OK, 202 = accepted (key validation pending) — both fine
    if (submit.status !== 200 && submit.status !== 202) {
      const text = await submit.text().catch(() => '');
      log.error('IndexNow submit failed:', submit.status, text.slice(0, 200));
      return errorResponse(`IndexNow rejected: ${submit.status}`, 502);
    }

    // Only advance the snapshot after a successful submit so failures retry
    await kvSet(KV_SNAPSHOT, current, { ttl: 90 * 24 * 3600 });

    log.info(`Submitted ${changed.length}/${total} URLs (status ${submit.status})`);
    return successResponse({
      submitted: changed.length,
      total,
      firstRun: !previous,
      indexNowStatus: submit.status,
    });
  } catch (error: unknown) {
    log.error('Error:', error);
    return errorResponse(error instanceof Error ? error.message : 'IndexNow cron failed', 500);
  }
};
