// replace-timeouts.cjs — Replace magic timeout numbers with TIMEOUTS constants
// Only replaces fetchWithTimeout 3rd args and setTimeout for API fetch timeouts

const fs = require('fs');
const path = require('path');

// Files to skip (not real timeouts, or client-side)
const SKIP_FILES = new Set([
  // Client-side files that can't import server modules
  'src/lib/checkout-client.ts',
  'src/lib/embed-player.ts',
  'src/lib/playlist-modal-init.ts',
  'src/lib/playlist-manager.ts',
  'src/lib/playlist-manager/metadata.ts',
  'src/lib/playlist-manager/ui.ts',
  'src/lib/playlist-manager/history.ts',
  'src/lib/release-plate-client.ts',
  'src/lib/shuffle-player-client.ts',
  'src/lib/client-logger.ts',
  'src/lib/dom-polyfill.ts',
  // Files where numbers aren't timeouts
  'src/lib/validation.ts',  // z.string().max(5000) — string length
  'src/lib/error-logger.ts',  // .slice(0, 5000) — string truncation
  'src/lib/livestream-slots/schemas.ts', // z.string().max(5000) — schema limit
  'src/lib/livestream-slots/helpers.ts', // CACHE_TTL, ms-to-minutes math
  'src/lib/livestream-slots/relay.ts', // ms-to-minutes math
  'src/lib/livestream-slots/management.ts', // ms-to-minutes math
  'src/lib/playlist-manager/history.ts', // ms-to-minutes math
  'src/lib/playlist/helpers.ts', // RECENTLY_PLAYED_CACHE_TTL
]);

// API files where numbers aren't timeouts
const SKIP_API_PATTERNS = [
  'src/pages/api/contact.ts', // z.string().max(5000) — form field
  'src/pages/api/delete-account.ts', // z.string().max(5000)
  'src/pages/api/log-error.ts', // z.string().max(5000)
  'src/pages/api/user/export-data.ts', // z.string().max(5000)
  'src/pages/api/mix/finalize-upload.ts', // has both timeout + z.string().max — handle carefully
  'src/pages/api/update-mix.ts', // z.string().max(5000/10000)
  'src/pages/api/livestream/event-requests.ts', // z.string().max(5000)
  'src/pages/api/vinyl/listing.ts', // MAX_PRICE = 10000
  'src/pages/api/cron/backup-d1.ts', // PAGE_SIZE = 10000
  'src/pages/api/admin/fix-submitter-ids.ts', // limit: 5000
  'src/pages/api/admin/migrate-orders-to-ledger.ts', // limit: 5000
  'src/pages/api/admin/backfill-followers.ts', // queryCollection limit
  'src/pages/api/cron/weekly-digest.ts', // queryCollection limit
  'src/pages/api/admin/check-release.ts', // cacheTime: 60000
  'src/pages/api/admin/bypass-requests.ts', // cacheTime: 60000
  'src/pages/api/admin/find-release.ts', // cacheTime: 60000
  'src/pages/api/playlist/global.ts', // time elapsed comparison
  'src/pages/api/livestream/status.ts', // cacheTime: 30000
  'src/pages/api/icecast-auth.ts', // ms-to-minutes math
];

const ROOT = path.resolve(__dirname, '..');

let totalChanges = 0;
const changedFiles = [];

function processFile(relPath) {
  const absPath = path.join(ROOT, relPath);
  if (!fs.existsSync(absPath)) return;

  let content = fs.readFileSync(absPath, 'utf8');
  const original = content;

  // Pattern 1: fetchWithTimeout(..., 10000) -> fetchWithTimeout(..., TIMEOUTS.API)
  // But only the 3rd argument
  content = content.replace(/(\bfetchWithTimeout\([^)]*,\s*)10000(\s*\))/g, '$1TIMEOUTS.API$2');

  // Pattern 2: fetchWithTimeout(..., 30000) -> fetchWithTimeout(..., TIMEOUTS.LONG)
  content = content.replace(/(\bfetchWithTimeout\([^)]*,\s*)30000(\s*\))/g, '$1TIMEOUTS.LONG$2');

  // Pattern 3: fetchWithTimeout(..., 5000) -> fetchWithTimeout(..., TIMEOUTS.SHORT)
  content = content.replace(/(\bfetchWithTimeout\([^)]*,\s*)5000(\s*\))/g, '$1TIMEOUTS.SHORT$2');

  // Pattern 4: setTimeout(() => controller.abort(), 10000) -> TIMEOUTS.API
  content = content.replace(/(setTimeout\(\s*\(\)\s*=>\s*controller\.abort\(\)\s*,\s*)10000(\s*\))/g, '$1TIMEOUTS.API$2');
  content = content.replace(/(setTimeout\(\s*\(\)\s*=>\s*controller\.abort\(\)\s*,\s*)30000(\s*\))/g, '$1TIMEOUTS.LONG$2');
  content = content.replace(/(setTimeout\(\s*\(\)\s*=>\s*controller\.abort\(\)\s*,\s*)5000(\s*\))/g, '$1TIMEOUTS.SHORT$2');

  // Pattern 5: AbortSignal.timeout(5000) -> AbortSignal.timeout(TIMEOUTS.SHORT)
  content = content.replace(/AbortSignal\.timeout\(5000\)/g, 'AbortSignal.timeout(TIMEOUTS.SHORT)');
  content = content.replace(/AbortSignal\.timeout\(10000\)/g, 'AbortSignal.timeout(TIMEOUTS.API)');

  // Pattern 6: }, 10000); where it's a fetchWithTimeout arg on previous lines (multiline)
  // These are harder — handle specific known patterns
  // fetchWithTimeout(\n  url,\n  opts,\n  10000\n)
  content = content.replace(/(fetchWithTimeout\([^)]*,\s*\n\s*)10000(\s*\n\s*\))/g, '$1TIMEOUTS.API$2');
  content = content.replace(/(fetchWithTimeout\([^)]*,\s*\n\s*)5000(\s*\n\s*\))/g, '$1TIMEOUTS.SHORT$2');
  content = content.replace(/(fetchWithTimeout\([^)]*,\s*\n\s*)30000(\s*\n\s*\))/g, '$1TIMEOUTS.LONG$2');

  if (content === original) return;

  // Now add TIMEOUTS to the import if not already present
  if (!content.includes("import { TIMEOUTS }") && !content.includes("TIMEOUTS") === false) {
    // File already has TIMEOUTS somehow
  }

  if (content.includes('TIMEOUTS.') && !content.includes("'../timeouts'") && !content.includes("'./timeouts'") && !content.includes("'../../lib/timeouts'")) {
    // Add TIMEOUTS to existing api-utils import
    if (content.includes("from '../../lib/api-utils'")) {
      if (!content.includes('TIMEOUTS')) {
        // shouldn't happen since we just added TIMEOUTS.XXX
      }
      content = content.replace(
        /import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/lib\/api-utils'/,
        (match, imports) => {
          if (imports.includes('TIMEOUTS')) return match;
          return `import {${imports}, TIMEOUTS } from '../../lib/api-utils'`;
        }
      );
    } else if (content.includes("from '../../../lib/api-utils'")) {
      content = content.replace(
        /import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/\.\.\/lib\/api-utils'/,
        (match, imports) => {
          if (imports.includes('TIMEOUTS')) return match;
          return `import {${imports}, TIMEOUTS } from '../../../lib/api-utils'`;
        }
      );
    } else if (content.includes("from '../../../../lib/api-utils'")) {
      content = content.replace(
        /import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/\.\.\/\.\.\/lib\/api-utils'/,
        (match, imports) => {
          if (imports.includes('TIMEOUTS')) return match;
          return `import {${imports}, TIMEOUTS } from '../../../../lib/api-utils'`;
        }
      );
    } else if (content.includes("from './api-utils'")) {
      content = content.replace(
        /import\s*\{([^}]+)\}\s*from\s*'\.\/api-utils'/,
        (match, imports) => {
          if (imports.includes('TIMEOUTS')) return match;
          return `import {${imports}, TIMEOUTS } from './api-utils'`;
        }
      );
    } else if (content.includes("from '../api-utils'")) {
      content = content.replace(
        /import\s*\{([^}]+)\}\s*from\s*'\.\.\/api-utils'/,
        (match, imports) => {
          if (imports.includes('TIMEOUTS')) return match;
          return `import {${imports}, TIMEOUTS } from '../api-utils'`;
        }
      );
    } else {
      // No api-utils import — add standalone TIMEOUTS import
      // Determine relative path
      let importPath;
      if (relPath.startsWith('src/lib/')) {
        const depth = relPath.split('/').length - 2; // src/lib = depth 2
        if (depth === 2) importPath = './timeouts';
        else if (depth === 3) importPath = '../timeouts';
        else importPath = '../../timeouts';
      } else if (relPath.startsWith('src/pages/api/')) {
        const depth = relPath.split('/').length - 2;
        if (depth === 3) importPath = '../../../lib/timeouts';
        else if (depth === 4) importPath = '../../../../lib/timeouts';
        else importPath = '../../lib/timeouts';
      }
      if (importPath) {
        // Add import after the last import line
        const lines = content.split('\n');
        let lastImportIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('import ')) lastImportIdx = i;
        }
        if (lastImportIdx >= 0) {
          lines.splice(lastImportIdx + 1, 0, `import { TIMEOUTS } from '${importPath}';`);
          content = lines.join('\n');
        }
      }
    }
  }

  fs.writeFileSync(absPath, content, 'utf8');
  const changes = (original.match(/\b(10000|30000|5000)\b/g) || []).length - (content.match(/\b(10000|30000|5000)\b/g) || []).length;
  totalChanges += Math.abs(changes) || 1;
  changedFiles.push(relPath);
}

// Collect all files to process
const libFiles = [];
const apiFiles = [];

function walkDir(dir, prefix) {
  const entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walkDir(relPath, prefix);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
      if (prefix === 'lib') libFiles.push(relPath);
      else apiFiles.push(relPath);
    }
  }
}

walkDir('src/lib', 'lib');
walkDir('src/pages/api', 'api');

// Process lib files (skip client-side and non-timeout files)
for (const f of libFiles) {
  if (SKIP_FILES.has(f)) continue;
  processFile(f);
}

// Process API files (skip non-timeout files)
for (const f of apiFiles) {
  if (SKIP_API_PATTERNS.includes(f)) continue;
  processFile(f);
}

console.log(`Changed ${changedFiles.length} files with ${totalChanges} replacements:`);
changedFiles.forEach(f => console.log(`  ${f}`));
