#!/usr/bin/env node
// scripts/backfill-mix-og.cjs
// Drives the /api/admin/backfill-mix-og/ endpoint until all mixes have a
// Facebook OG image (1200x630). Each call processes a small batch (default 3)
// to stay under Worker CPU budget.
//
// Usage:
//   ADMIN_KEY=xxxx node scripts/backfill-mix-og.cjs
//   ADMIN_KEY=xxxx node scripts/backfill-mix-og.cjs --base=https://freshwax.co.uk
//   ADMIN_KEY=xxxx node scripts/backfill-mix-og.cjs --dry-run
//   ADMIN_KEY=xxxx node scripts/backfill-mix-og.cjs --mixId=abc123  # one-off

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith('--base=')) || '--base=https://freshwax.co.uk').slice('--base='.length);
const dryRun = args.includes('--dry-run');
const oneMixId = (args.find((a) => a.startsWith('--mixId=')) || '').slice('--mixId='.length) || null;
const limit = parseInt((args.find((a) => a.startsWith('--limit=')) || '--limit=3').slice('--limit='.length), 10) || 3;

const adminKey = process.env.ADMIN_KEY;
if (!adminKey) {
  console.error('ERROR: ADMIN_KEY env var not set');
  process.exit(1);
}

async function callBackfill(body) {
  // adminBulk limiter = 5 req/60s then a 5-min block; retry on 429 instead of dying.
  for (;;) {
    const res = await fetch(`${baseUrl}/api/admin/backfill-mix-og/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    if (res.status === 429) {
      const wait = (json.retryAfter || 60) + 2;
      console.log(`  …rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }
}

(async () => {
  console.log(`Backfilling Facebook OG images for mixes`);
  console.log(`  base   : ${baseUrl}`);
  console.log(`  limit  : ${limit} per call`);
  console.log(`  dryRun : ${dryRun}`);
  if (oneMixId) console.log(`  mixId  : ${oneMixId} (single-mix mode)`);
  console.log('');

  let totalOk = 0;
  let totalFail = 0;
  let calls = 0;
  const failures = [];

  if (oneMixId) {
    const r = await callBackfill({ mixId: oneMixId, dryRun });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  while (true) {
    calls++;
    const r = await callBackfill({ limit, dryRun });
    if (r.candidates === 0) {
      console.log(`[done] No more candidates after ${calls - 1} calls.`);
      break;
    }
    for (const item of r.results || []) {
      if (item.ok) {
        totalOk++;
        process.stdout.write(`  ✓ ${item.mixId} (${item.sizeKB ?? '?'}KB)\n`);
      } else {
        totalFail++;
        failures.push(item);
        process.stdout.write(`  ✗ ${item.mixId} — ${item.error || 'unknown'}\n`);
      }
    }
    if (r.processed === 0 && r.candidates > 0) {
      console.log(`[stuck] ${r.candidates} candidates but 0 processed — stopping to avoid infinite loop.`);
      break;
    }
    // Pace under the adminBulk limiter (5 req/60s)
    await new Promise((res) => setTimeout(res, 13000));
  }

  console.log('');
  console.log(`Done. ${totalOk} succeeded, ${totalFail} failed across ${calls} calls.`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  ${f.mixId}: ${f.error}`);
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
