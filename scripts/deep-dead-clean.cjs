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

/**
 * A selector is dead if ANY of its classes are dead.
 * If a class never appears in source, no element will have it,
 * so any selector requiring that class can never match.
 */
function isSelectorDead(sel, deadClasses) {
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.some(c => deadClasses.has(c));
}

function deepClean(cssFile, deadClasses) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const origLines = css.split('\n').length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedCount = 0;
  let removedLines = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    // Pass through comments, blank, @-rules
    if (!t || t.startsWith('/*') || t.startsWith('@')) {
      output.push(lines[i]);
      i++;
      continue;
    }

    // Check if this starts with a class selector
    if (t.match(/^[.#a-zA-Z\[\*:>+~]/) && !t.startsWith('@')) {
      // Collect full selector
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

        // Check if ALL selectors in the comma group are dead
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
          removedLines += (endLine - i + 1);
          i = endLine + 1;
          continue;
        }

        // Check if SOME selectors are dead
        const liveList = sels.filter(s => !isSelectorDead(s, deadClasses));
        if (liveList.length < sels.length && liveList.length > 0) {
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

          // Extract body content
          const bodyParts = [];
          let foundBrace = false;
          for (let k = i; k <= endLine; k++) {
            if (!foundBrace) {
              const bIdx = lines[k].indexOf('{');
              if (bIdx >= 0) {
                foundBrace = true;
                const rest = lines[k].substring(bIdx + 1).trim();
                if (rest && rest !== '}') bodyParts.push('  ' + rest);
              }
            } else if (k === endLine) {
              const cIdx = lines[k].lastIndexOf('}');
              if (cIdx >= 0) {
                const before = lines[k].substring(0, cIdx).trim();
                if (before) bodyParts.push('  ' + before);
              }
            } else {
              if (lines[k].trim()) bodyParts.push(lines[k]);
            }
          }

          const indent = lines[i].match(/^(\s*)/)[1];
          output.push(indent + liveList.join(',\n' + indent) + ' {');
          for (const bp of bodyParts) output.push(bp);
          output.push(indent + '}');

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
    if (depth < 0) { console.log('ERROR: unbalanced braces!'); return; }
  }
  if (depth !== 0) { console.log('ERROR: ' + depth + ' unclosed braces!'); return; }

  const newLen = result.length;
  const newLines = result.split('\n').length;

  console.log(cssFile + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (-' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  Rules removed: ' + removedCount);

  fs.writeFileSync(cssFile, result);
}

// DJ Lobby
const djText = getAllText([
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
]);
const djDead = findDeadClasses('src/styles/dj-lobby.css', djText);
console.log('DJ Lobby dead: ' + djDead.size + ' - ' + [...djDead].sort().join(', '));
deepClean('src/styles/dj-lobby.css', djDead);

console.log('');

// Live
const liveText = getAllText([
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...getJsFiles('public/live'),
]);
const liveDead = findDeadClasses('src/styles/live.css', liveText);
console.log('Live dead: ' + liveDead.size + ' - ' + [...liveDead].sort().join(', '));
deepClean('src/styles/live.css', liveDead);
