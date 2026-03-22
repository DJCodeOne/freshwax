// replace-timeouts-v2.cjs — Handle remaining multiline fetchWithTimeout patterns
// Pattern: }, 10000); where the fetchWithTimeout spans multiple lines

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Files to skip completely (client-side or non-timeout values)
const SKIP_FILES = new Set([
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
  'src/lib/validation.ts',
  'src/lib/error-logger.ts',
  'src/lib/livestream-slots/schemas.ts',
  'src/lib/livestream-slots/helpers.ts',
  'src/lib/livestream-slots/relay.ts',
  'src/lib/livestream-slots/management.ts',
  'src/lib/playlist-manager/history.ts',
]);

let totalChanges = 0;
const changedFiles = [];

function processFile(relPath) {
  const absPath = path.join(ROOT, relPath);
  if (!fs.existsSync(absPath)) return;
  if (SKIP_FILES.has(relPath)) return;

  let content = fs.readFileSync(absPath, 'utf8');
  const original = content;

  // Track if we find fetchWithTimeout calls with multiline patterns
  // Pattern: fetchWithTimeout(url, {\n  ...opts\n}, 10000);
  // The }, 10000); is on the closing line

  // We need to verify that }, 10000); is actually the end of a fetchWithTimeout call
  // Strategy: find all fetchWithTimeout( and track to their closing ), replacing the timeout arg

  // Simple multiline pattern: the timeout value appears on its own line
  // e.g.:
  //   10000
  // );
  content = content.replace(
    /(\bfetchWithTimeout\([\s\S]*?),\s*\n(\s*)10000\n(\s*\))/g,
    (match, before, indent, closing) => {
      return `${before},\n${indent}TIMEOUTS.API\n${closing}`;
    }
  );
  content = content.replace(
    /(\bfetchWithTimeout\([\s\S]*?),\s*\n(\s*)30000\n(\s*\))/g,
    (match, before, indent, closing) => {
      return `${before},\n${indent}TIMEOUTS.LONG\n${closing}`;
    }
  );
  content = content.replace(
    /(\bfetchWithTimeout\([\s\S]*?),\s*\n(\s*)5000\n(\s*\))/g,
    (match, before, indent, closing) => {
      return `${before},\n${indent}TIMEOUTS.SHORT\n${closing}`;
    }
  );

  // Pattern: }, 10000); — fetchWithTimeout closing with object arg followed by timeout
  // Must verify it's inside fetchWithTimeout
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for }, NNNNN); pattern
    const match10k = line.match(/^(\s*)\}, 10000\);/);
    const match30k = line.match(/^(\s*)\}, 30000\);/);
    const match5k = line.match(/^(\s*)\}, 5000\);/);
    const matchVal = match10k || match30k || match5k;
    if (!matchVal) continue;

    // Look backwards to find the fetchWithTimeout( that this closes
    let depth = 0;
    let foundFWT = false;
    for (let j = i; j >= Math.max(0, i - 30); j--) {
      const prevLine = lines[j];
      // Count closing parens (going backwards, so closings are openings)
      for (const ch of prevLine) {
        if (ch === ')') depth++;
        if (ch === '(') depth--;
      }
      if (prevLine.includes('fetchWithTimeout(')) {
        foundFWT = true;
        break;
      }
    }

    if (!foundFWT) continue;

    // Replace the value
    if (match10k) {
      lines[i] = lines[i].replace('}, 10000);', '}, TIMEOUTS.API);');
    } else if (match30k) {
      lines[i] = lines[i].replace('}, 30000);', '}, TIMEOUTS.LONG);');
    } else if (match5k) {
      lines[i] = lines[i].replace('}, 5000);', '}, TIMEOUTS.SHORT);');
    }
  }
  content = lines.join('\n');

  // Also handle: fetchWithTimeout(url.toString(), {}, 10000);  (single line already done by v1)
  // And: fetchWithTimeout(url, {}, 10000);
  content = content.replace(/(\bfetchWithTimeout\([^)]*,\s*\{\}\s*,\s*)10000(\s*\))/g, '$1TIMEOUTS.API$2');
  content = content.replace(/(\bfetchWithTimeout\([^)]*,\s*\{\}\s*,\s*)5000(\s*\))/g, '$1TIMEOUTS.SHORT$2');
  content = content.replace(/(\bfetchWithTimeout\([^)]*,\s*\{\}\s*,\s*)30000(\s*\))/g, '$1TIMEOUTS.LONG$2');

  if (content === original) return;

  // Add TIMEOUTS to import if needed
  if (content.includes('TIMEOUTS.')) {
    // Check if TIMEOUTS is already imported
    if (content.includes("TIMEOUTS") && content.match(/import\s*\{[^}]*TIMEOUTS[^}]*\}/)) {
      // Already imported
    } else {
      // Try adding to existing api-utils import
      const importPatterns = [
        /from '\.\/api-utils'/,
        /from '\.\.\/api-utils'/,
        /from '\.\.\/\.\.\/lib\/api-utils'/,
        /from '\.\.\/\.\.\/\.\.\/lib\/api-utils'/,
        /from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/api-utils'/,
      ];

      let added = false;
      for (const pat of importPatterns) {
        if (pat.test(content)) {
          const importPat = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*'${pat.source.replace(/from '/, '').replace(/'/, '')}'`);
          content = content.replace(importPat, (match, imports) => {
            if (imports.includes('TIMEOUTS')) return match;
            return match.replace(imports, `${imports}, TIMEOUTS`);
          });
          added = true;
          break;
        }
      }

      if (!added) {
        // Add standalone import
        let importPath;
        if (relPath.startsWith('src/lib/')) {
          const depth = relPath.split('/').length - 3;
          importPath = depth === 0 ? './timeouts' : '../'.repeat(depth) + 'timeouts';
        } else if (relPath.startsWith('src/pages/api/')) {
          const depth = relPath.split('/').length - 4;
          importPath = '../'.repeat(depth + 1) + 'lib/timeouts';
        }
        if (importPath) {
          const firstImportIdx = content.indexOf('import ');
          if (firstImportIdx >= 0) {
            // Find the end of imports
            const lines2 = content.split('\n');
            let lastImportIdx = -1;
            for (let i = 0; i < lines2.length; i++) {
              if (lines2[i].trimStart().startsWith('import ')) lastImportIdx = i;
            }
            if (lastImportIdx >= 0) {
              lines2.splice(lastImportIdx + 1, 0, `import { TIMEOUTS } from '${importPath}';`);
              content = lines2.join('\n');
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(absPath, content, 'utf8');
  changedFiles.push(relPath);
  totalChanges++;
}

// Walk directories
function walkDir(dir) {
  const entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.git') continue;
      walkDir(relPath);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      processFile(relPath);
    }
  }
}

walkDir('src/lib');
walkDir('src/pages/api');

console.log(`Changed ${changedFiles.length} additional files:`);
changedFiles.forEach(f => console.log(`  ${f}`));
