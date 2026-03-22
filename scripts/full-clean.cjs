const fs = require('fs');
const path = require('path');

function getJsFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)); }
  catch { return []; }
}

function getAllText(files) {
  return files.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
}

function findDeadClasses(cssFile, sourceText) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const dead = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    if (!sourceText.includes(m[1])) dead.add(m[1]);
  }
  return dead;
}

function checkBraces(css) {
  let d = 0;
  for (const ch of css) {
    if (ch === '{') d++;
    if (ch === '}') d--;
    if (d < 0) return false;
  }
  return d === 0;
}

/**
 * A selector is dead if ANY of its classes are dead (never appear in source).
 * If a class doesn't exist in the HTML/JS, no element will have it,
 * so any CSS selector requiring that class can never match.
 */
function isSelectorDead(sel, deadClasses) {
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.some(c => deadClasses.has(c));
}

function fullClean(cssFile, deadClasses, deadKeyframeNames) {
  let css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const origLineCount = css.split('\n').length;

  if (!checkBraces(css)) {
    console.log('ERROR: ' + cssFile + ' already has broken braces!');
    return;
  }

  // Phase 1: Remove dead @keyframes
  for (const kf of deadKeyframeNames) {
    const lines = css.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      const nameMatch = t.match(/@keyframes\s+([\w-]+)/);
      if (nameMatch && nameMatch[1] === kf) {
        let depth = 0;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
          }
          if (depth <= 0) { i = j + 1; break; }
        }
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    css = out.join('\n');
  }

  // Phase 2: Remove dead rules (only when ALL selectors in comma group are dead)
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedRules = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    // Pass through blank, comments, @-rules
    if (!t || t.startsWith('/*') || t.startsWith('@')) {
      output.push(lines[i]);
      i++;
      continue;
    }

    // Check for selector line (starts with . or contains . before {)
    if (t.match(/^[.#a-zA-Z\[\*:>+~]/) && !t.startsWith('@')) {
      // Collect full selector (may span multiple lines with commas)
      let fullSel = t;
      let j = i;
      while (!fullSel.includes('{') && j + 1 < lines.length) {
        j++;
        fullSel += ' ' + lines[j].trim();
      }

      const braceIdx = fullSel.indexOf('{');
      if (braceIdx >= 0) {
        const selPart = fullSel.substring(0, braceIdx).trim();
        const sels = selPart.split(',').map(s => s.trim()).filter(s => s);

        // Remove only if ALL selectors are dead
        if (sels.length > 0 && sels.every(s => isSelectorDead(s, deadClasses))) {
          // Find closing brace
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
          removedRules++;
          i = endLine + 1;
          continue;
        }
      }
    }

    output.push(lines[i]);
    i++;
  }

  // Phase 3: Clean up
  let result = output.join('\n');

  // Collapse 3+ blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  // Remove empty media queries
  result = result.replace(/@media[^{]+\{\s*\n?\s*\}/g, '');

  // Remove orphaned comments
  const fLines = result.split('\n');
  const cleaned = [];
  for (let k = 0; k < fLines.length; k++) {
    const ft = fLines[k].trim();
    if (ft.startsWith('/*') && ft.endsWith('*/')) {
      let next = k + 1;
      while (next < fLines.length && fLines[next].trim() === '') next++;
      if (next >= fLines.length) continue;
      const nextT = fLines[next].trim();
      if (nextT.startsWith('/*') && nextT.endsWith('*/')) continue;
      if (nextT === '}') continue;
    }
    cleaned.push(fLines[k]);
  }
  result = cleaned.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Final brace check
  if (!checkBraces(result)) {
    console.log('ERROR: ' + cssFile + ' broken after cleanup! NOT saving.');
    return;
  }

  const newLen = result.length;
  const newLineCount = result.split('\n').length;

  console.log(cssFile + ':');
  console.log('  Lines: ' + origLineCount + ' -> ' + newLineCount + ' (-' + (origLineCount - newLineCount) + ')');
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  Rules removed: ' + removedRules);

  fs.writeFileSync(cssFile, result);
}

function findDeadKeyframes(cssFile, sourceFiles) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]);
  const allText = css + '\n' + sourceFiles.map(f => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }).join('\n');

  const dead = [];
  for (const kf of keyframes) {
    const re = new RegExp('animation(?:-name)?\\s*:[^;]*\\b' + kf.replace(/-/g, '\\-') + '\\b');
    if (!re.test(allText)) dead.push(kf);
  }
  return dead;
}

// ===== DJ LOBBY =====
console.log('=== DJ Lobby ===');
const djSourceFiles = [
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
];
const djText = getAllText(djSourceFiles);
const djDead = findDeadClasses('src/styles/dj-lobby.css', djText);
const djDeadKf = findDeadKeyframes('src/styles/dj-lobby.css', djSourceFiles);
console.log('Dead classes: ' + djDead.size);
console.log('Dead keyframes: ' + djDeadKf.length + ' - ' + djDeadKf.join(', '));
fullClean('src/styles/dj-lobby.css', djDead, djDeadKf);

console.log('');

// ===== LIVE =====
console.log('=== Live ===');
const liveSourceFiles = [
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...getJsFiles('public/live'),
];
const liveText = getAllText(liveSourceFiles);
const liveDead = findDeadClasses('src/styles/live.css', liveText);
const liveDeadKf = findDeadKeyframes('src/styles/live.css', liveSourceFiles);
console.log('Dead classes: ' + liveDead.size);
console.log('Dead keyframes: ' + liveDeadKf.length + ' - ' + liveDeadKf.join(', '));
fullClean('src/styles/live.css', liveDead, liveDeadKf);
