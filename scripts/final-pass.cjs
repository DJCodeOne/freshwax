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

function isSelectorDead(sel, dead) {
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  return classes.length > 0 && classes.some(c => dead.has(c));
}

function finalPass(cssFile, deadClasses) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removed = 0;

  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || t.startsWith('/*') || t.startsWith('@')) {
      output.push(lines[i]);
      i++;
      continue;
    }

    if (t.startsWith('.') || t.match(/^[a-zA-Z]/)) {
      let fullSel = t;
      let j = i;
      while (!fullSel.includes('{') && j + 1 < lines.length) {
        j++;
        fullSel += ' ' + lines[j].trim();
      }

      const bIdx = fullSel.indexOf('{');
      if (bIdx >= 0) {
        const selPart = fullSel.substring(0, bIdx).trim();
        const sels = selPart.split(',').map(s => s.trim()).filter(s => s);

        if (sels.length > 0 && sels.every(s => isSelectorDead(s, deadClasses))) {
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
          removed++;
          i = endLine + 1;
          continue;
        }
      }
    }

    output.push(lines[i]);
    i++;
  }

  let result = output.join('\n').replace(/\n{3,}/g, '\n\n');

  // Brace check
  let depth = 0;
  for (const ch of result) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log('  ERROR: broken braces!'); return; }
  }
  if (depth !== 0) { console.log('  ERROR: ' + depth + ' unclosed!'); return; }

  console.log(cssFile + ': ' + origLen + ' -> ' + result.length + ' (-' + (origLen - result.length) + '), removed ' + removed + ' rules');
  fs.writeFileSync(cssFile, result);
}

// DJ Lobby
const djText = getAllText([
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
]);
const djDead = findDeadClasses('src/styles/dj-lobby.css', djText);
console.log('DJ dead: ' + djDead.size + ' - ' + [...djDead].sort().join(', '));
finalPass('src/styles/dj-lobby.css', djDead);

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
finalPass('src/styles/live.css', liveDead);
