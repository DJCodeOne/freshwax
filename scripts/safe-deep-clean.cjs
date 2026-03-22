const fs = require('fs');
const path = require('path');

function getJsFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
  } catch { return []; }
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

function isSelectorDead(sel, deadClasses) {
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.some(c => deadClasses.has(c));
}

function safeClean(cssFile, deadClasses) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedCount = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (!t || t.startsWith('/*') || t.startsWith('@')) {
      output.push(lines[i]);
      i++;
      continue;
    }

    // Only handle lines that start with a class selector
    if (t.startsWith('.') && !t.startsWith('/*')) {
      // Collect full selector
      let fullSel = t;
      let startIdx = i;
      let j = i;
      while (!fullSel.includes('{') && j + 1 < lines.length) {
        j++;
        fullSel += ' ' + lines[j].trim();
      }

      const braceIdx = fullSel.indexOf('{');
      if (braceIdx >= 0) {
        const selPart = fullSel.substring(0, braceIdx).trim();
        const sels = selPart.split(',').map(s => s.trim()).filter(s => s);

        // ONLY remove if ALL selectors in comma group are dead
        // (don't try to rewrite mixed selectors - that's error-prone)
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

          removedCount++;
          i = endLine + 1;
          continue;
        }
      }
    }

    output.push(lines[i]);
    i++;
  }

  let result = output.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Remove orphaned comments
  const fLines = result.split('\n');
  const cleaned = [];
  for (let k = 0; k < fLines.length; k++) {
    const ft = fLines[k].trim();
    if (ft.startsWith('/*') && ft.endsWith('*/')) {
      let next = k + 1;
      while (next < fLines.length && fLines[next].trim() === '') next++;
      if (next >= fLines.length) continue;
      if (fLines[next].trim().startsWith('/*') && fLines[next].trim().endsWith('*/')) continue;
    }
    cleaned.push(fLines[k]);
  }
  result = cleaned.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Verify braces
  let depth = 0;
  for (const ch of result) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log('ERROR: unbalanced braces at depth ' + depth); return; }
  }
  if (depth !== 0) { console.log('ERROR: ' + depth + ' unclosed braces!'); return; }

  const newLen = result.length;
  const newLines = result.split('\n').length;
  console.log(cssFile + ':');
  console.log('  Lines: ' + lines.length + ' -> ' + newLines + ' (-' + (lines.length - newLines) + ')');
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  Rules removed: ' + removedCount);

  fs.writeFileSync(cssFile, result);
}

// Live only (dj-lobby already done)
const liveText = getAllText([
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...getJsFiles('public/live'),
]);
const liveDead = findDeadClasses('src/styles/live.css', liveText);
console.log('Live dead: ' + liveDead.size);
safeClean('src/styles/live.css', liveDead);
