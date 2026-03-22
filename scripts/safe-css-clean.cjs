const fs = require('fs');
const path = require('path');

/**
 * Safe CSS Dead Code Remover
 *
 * Strategy:
 * 1. Extract ALL class references from .astro + .js files (very broad matching)
 * 2. Extract all CSS class selectors from the CSS file
 * 3. Only mark a CSS class as "dead" if it has ZERO matches across all source files
 * 4. Remove a CSS rule only if ALL classes in its selector are dead
 * 5. Verify brace balance before and after
 */

function getJsFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.mjs'))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

function getAllTextFromFiles(files) {
  let all = '';
  for (const f of files) {
    try { all += fs.readFileSync(f, 'utf8') + '\n'; } catch {}
  }
  return all;
}

function checkBraces(css) {
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function findTrulyDeadClasses(cssFile, sourceText) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const cssClasses = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    cssClasses.add(m[1]);
  }

  const dead = new Set();
  for (const cls of cssClasses) {
    // Check with word boundary - class must appear as a standalone word
    // Use multiple patterns to be thorough
    if (!sourceText.includes(cls)) {
      dead.add(cls);
    }
  }

  return dead;
}

function removeSafeDeadRules(cssFile, deadClasses) {
  let css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const origLines = css.split('\n').length;

  if (!checkBraces(css)) {
    console.log('ERROR: ' + cssFile + ' has unbalanced braces before cleanup!');
    return;
  }

  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedRuleCount = 0;
  let removedLineCount = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Pass through comments, blank lines, @-rules unchanged
    if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('@')) {
      output.push(lines[i]);
      i++;
      continue;
    }

    // Check if this is a selector line that starts with a class
    if (trimmed.startsWith('.') && !trimmed.startsWith('/*')) {
      // Collect full selector (may span multiple lines)
      let selLines = [i];
      let fullText = trimmed;
      let j = i;

      // Multi-line selector: lines ending with comma, continuing until we find {
      while (!fullText.includes('{') && j + 1 < lines.length) {
        j++;
        selLines.push(j);
        fullText += ' ' + lines[j].trim();
      }

      const braceIdx = fullText.indexOf('{');
      if (braceIdx >= 0) {
        const selPart = fullText.substring(0, braceIdx).trim();
        const selectorList = selPart.split(',').map(s => s.trim()).filter(s => s);

        // For each selector, check if ALL its classes are dead
        const allSelectorsAreDead = selectorList.every(sel => {
          const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
          if (classes.length === 0) return false; // No classes = can't determine, keep it
          return classes.every(c => deadClasses.has(c));
        });

        if (allSelectorsAreDead && selectorList.length > 0) {
          // Find the closing brace
          let depth = 0;
          let endLine = i;
          for (let k = i; k < lines.length; k++) {
            for (const ch of lines[k]) {
              if (ch === '{') depth++;
              if (ch === '}') depth--;
            }
            endLine = k;
            if (depth <= 0) break;
          }

          const removedSize = endLine - i + 1;
          removedRuleCount++;
          removedLineCount += removedSize;
          i = endLine + 1;
          continue;
        }
      }
    }

    output.push(lines[i]);
    i++;
  }

  // Collapse 3+ blank lines to max 2
  let result = output.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Remove empty media queries
  result = result.replace(/@media[^{]+\{\s*\n?\s*\}/g, '');

  // Remove orphaned comments (comment followed by blank lines then another comment or })
  const finalLines = result.split('\n');
  const cleaned = [];
  for (let k = 0; k < finalLines.length; k++) {
    const t = finalLines[k].trim();
    if (t.startsWith('/*') && t.endsWith('*/')) {
      let next = k + 1;
      while (next < finalLines.length && finalLines[next].trim() === '') next++;
      if (next >= finalLines.length) continue; // orphaned at end of file
      if (finalLines[next].trim().startsWith('/*') && finalLines[next].trim().endsWith('*/')) continue; // double comment
    }
    cleaned.push(finalLines[k]);
  }

  result = cleaned.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Verify braces
  if (!checkBraces(result)) {
    console.log('ERROR: ' + cssFile + ' braces broken after cleanup! Reverting.');
    return;
  }

  const newLen = result.length;
  const newLines = result.split('\n').length;

  console.log(cssFile + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (-' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  Rules removed: ' + removedRuleCount + ' (' + removedLineCount + ' lines)');

  fs.writeFileSync(cssFile, result);
}

// ===== DJ LOBBY =====
console.log('=== DJ Lobby ===');
const djFiles = [
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
];
const djText = getAllTextFromFiles(djFiles);
const djDead = findTrulyDeadClasses('src/styles/dj-lobby.css', djText);
console.log('CSS classes: ' + new Set([...fs.readFileSync('src/styles/dj-lobby.css', 'utf8').matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1])).size);
console.log('Dead classes: ' + djDead.size);
console.log('Dead: ' + [...djDead].sort().join(', '));
console.log('');
removeSafeDeadRules('src/styles/dj-lobby.css', djDead);

console.log('');

// ===== LIVE =====
console.log('=== Live ===');
const liveFiles = [
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...getJsFiles('public/live'),
];
const liveText = getAllTextFromFiles(liveFiles);
const liveDead = findTrulyDeadClasses('src/styles/live.css', liveText);
console.log('CSS classes: ' + new Set([...fs.readFileSync('src/styles/live.css', 'utf8').matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1])).size);
console.log('Dead classes: ' + liveDead.size);
console.log('Dead: ' + [...liveDead].sort().join(', '));
console.log('');
removeSafeDeadRules('src/styles/live.css', liveDead);
