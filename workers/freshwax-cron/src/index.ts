// freshwax-cron: maps cron triggers to the site's /api/cron/* endpoints.
// See wrangler.toml for why this worker exists (the old freshwax-api
// scheduled() handler was a no-op and nothing ever ran).
//
// The IndexNow job runs INSIDE this worker rather than as a Pages endpoint:
// a fetch to api.indexnow.org from a Pages Function kills the invocation
// with a platform "error code: 502" (verified Jul 14 2026 by bisect — the
// same request from this Worker gets a normal HTTP response).

export interface Env {
  CRON_SECRET: string;
  CACHE: KVNamespace;
}

const SITE = 'https://freshwax.co.uk';
const INDEXNOW_KEY = 'f299fb635350b61970ee0dd03b2c22d2'; // hosted at /<key>.txt on the site
const KV_SNAPSHOT = 'indexnow:sitemap-snapshot';
const MAX_URLS_PER_SUBMIT = 10000; // IndexNow protocol limit

// cron expression -> jobs to run (in order). 'indexnow' is special-cased
// to run in-worker; every other name is POSTed to /api/cron/<name>/.
const JOBS: Record<string, string[]> = {
  '0 * * * *': ['cleanup-reservations'],
  '0 */6 * * *': ['retry-payouts', 'send-restock-notifications'],
  // 02:00 daily chain — order matters: backup first, then SEO ping, then emails
  '0 2 * * *': ['backup-d1', 'indexnow', 'review-requests', 'release-preorders', 'notify-release-interest'],
  '0 3 * * *': ['cleanup-d1'],
  '0 4 * * *': ['image-scan'],
  '0 10 * * *': ['verification-reminders'],
  '0 10 * * SUN': ['weekly-digest'],
};

async function callEndpoint(name: string, env: Env): Promise<string> {
  const url = `${SITE}/api/cron/${name}/`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.CRON_SECRET}` },
      // generous ceiling — backup-d1 exports every table
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.text().catch(() => '');
    const line = `${name}: ${res.status} in ${Date.now() - started}ms — ${body.slice(0, 300)}`;
    console.log(`[cron] ${line}`);
    return line;
  } catch (err) {
    const line = `${name} FAILED after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[cron] ${line}`);
    return line;
  }
}

// Sitemap diff -> IndexNow ping (Bing/Yandex/etc). First run submits every
// URL; afterwards only new/changed lastmods. Snapshot only advances on a
// successful (200/202) submit so failures — including 429s — retry next run.
async function runIndexNow(env: Env): Promise<string> {
  const res = await fetch(`${SITE}/sitemap.xml`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return `indexnow: sitemap fetch failed (${res.status})`;
  const xml = await res.text();

  const current: Record<string, string> = {};
  for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) || []) {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] || '';
    if (loc) current[loc] = lastmod;
  }
  const total = Object.keys(current).length;
  if (total === 0) return 'indexnow: sitemap parsed to zero URLs — refusing to diff';

  const previous = await env.CACHE.get<Record<string, string>>(KV_SNAPSHOT, 'json');
  const changed = previous
    ? Object.keys(current).filter((u) => previous[u] === undefined || previous[u] !== current[u])
    : Object.keys(current);
  if (changed.length === 0) return `indexnow: no changes (${total} URLs tracked)`;

  const submit = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE).host,
      key: INDEXNOW_KEY,
      keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
      urlList: changed.slice(0, MAX_URLS_PER_SUBMIT),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (submit.status !== 200 && submit.status !== 202) {
    const text = await submit.text().catch(() => '');
    return `indexnow: rejected ${submit.status} — ${text.slice(0, 200)} (will retry next run)`;
  }

  await env.CACHE.put(KV_SNAPSHOT, JSON.stringify(current), { expirationTtl: 90 * 24 * 3600 });
  return `indexnow: submitted ${changed.length}/${total} URLs (status ${submit.status}, firstRun=${!previous})`;
}

async function runJob(name: string, env: Env): Promise<string> {
  if (name === 'indexnow') {
    try {
      const line = await runIndexNow(env);
      console.log(`[cron] ${line}`);
      return line;
    } catch (err) {
      const line = `indexnow FAILED: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[cron] ${line}`);
      return line;
    }
  }
  return callEndpoint(name, env);
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const jobs = JOBS[event.cron];
    if (!jobs) {
      console.error(`[cron] No job mapped for trigger "${event.cron}" — check wrangler.toml vs JOBS`);
      return;
    }
    console.log(`[cron] Trigger "${event.cron}" -> ${jobs.join(', ')}`);
    // Sequential on purpose: the 02:00 chain and 6-hourly pair are ordered.
    for (const name of jobs) {
      await runJob(name, env);
    }
  },

  // Manual poke: GET /run/<job> with the same bearer secret — lets ops
  // fire any job on demand without waiting for the schedule.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/run\/([a-z0-9-]+)$/);
    const auth = request.headers.get('Authorization') || '';
    if (!match) return new Response('freshwax-cron: use /run/<job>', { status: 404 });
    if (auth !== `Bearer ${env.CRON_SECRET}`) return new Response('unauthorized', { status: 403 });
    const line = await runJob(match[1], env);
    return new Response(line, { status: 200 });
  },
} satisfies ExportedHandler<Env>;
