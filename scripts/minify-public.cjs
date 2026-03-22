/**
 * Post-build script to minify JS files in dist/ that originated from public/.
 * These files bypass Vite's bundler since they live in public/ and are copied
 * as-is to dist/ during astro build.
 *
 * Skips _astro/ (already minified by Vite) and _worker.js (Cloudflare entry).
 *
 * Usage: node scripts/minify-public.cjs
 */

const fs = require('fs');
const path = require('path');
const { transform } = require('esbuild');

const DIST_DIR = path.join(__dirname, '..', 'dist');

// Directories/files to skip (already processed by Vite or Cloudflare adapter)
const SKIP_DIRS = ['_astro', '_worker.js'];
const SKIP_FILES = ['_worker.js'];

// Skip files that are already minified
const SKIP_SUFFIXES = ['.min.js'];

function findJsFiles(dir, isRoot) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read directory ${dir}: ${err.message}`);
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip Vite output directories at the dist root
      if (isRoot && SKIP_DIRS.includes(entry.name)) {
        continue;
      }
      results.push(...findJsFiles(fullPath, false));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      // Skip specific files at dist root
      if (isRoot && SKIP_FILES.includes(entry.name)) {
        continue;
      }
      // Skip already-minified files
      if (SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) {
        continue;
      }
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error('dist/ directory not found. Run "astro build" first.');
    process.exit(1);
  }

  const files = findJsFiles(DIST_DIR, true);

  if (files.length === 0) {
    console.log('No JS files to minify in dist/');
    return;
  }

  let totalBefore = 0;
  let totalAfter = 0;
  const results = [];

  for (const filePath of files) {
    const code = fs.readFileSync(filePath, 'utf8');
    const beforeSize = Buffer.byteLength(code, 'utf8');
    totalBefore += beforeSize;

    try {
      const result = await transform(code, {
        minify: true,
        loader: 'js',
      });

      const afterSize = Buffer.byteLength(result.code, 'utf8');
      totalAfter += afterSize;

      fs.writeFileSync(filePath, result.code, 'utf8');

      const saved = beforeSize - afterSize;
      const pct = beforeSize > 0 ? ((saved / beforeSize) * 100).toFixed(1) : '0.0';
      const rel = path.relative(DIST_DIR, filePath);
      results.push({ rel, beforeSize, afterSize, saved, pct });
    } catch (err) {
      console.error(`  ERROR minifying ${path.relative(DIST_DIR, filePath)}: ${err.message}`);
      totalAfter += beforeSize;
    }
  }

  // Print results sorted by savings (largest first)
  results.sort((a, b) => b.saved - a.saved);

  console.log('\nPublic JS minification (dist/):');
  console.log('─'.repeat(70));

  for (const r of results) {
    const before = (r.beforeSize / 1024).toFixed(1).padStart(7);
    const after = (r.afterSize / 1024).toFixed(1).padStart(7);
    const saved = (r.saved / 1024).toFixed(1).padStart(6);
    console.log(`  ${r.rel.padEnd(40)} ${before}KB → ${after}KB  (−${saved}KB, ${r.pct}%)`);
  }

  console.log('─'.repeat(70));
  const totalSaved = totalBefore - totalAfter;
  const totalPct = totalBefore > 0 ? ((totalSaved / totalBefore) * 100).toFixed(1) : '0.0';
  console.log(
    `  TOTAL: ${(totalBefore / 1024).toFixed(1)}KB → ${(totalAfter / 1024).toFixed(1)}KB  (−${(totalSaved / 1024).toFixed(1)}KB, ${totalPct}%)`
  );
  console.log('');
}

main().catch((err) => {
  console.error('minify-public failed:', err);
  process.exit(1);
});
