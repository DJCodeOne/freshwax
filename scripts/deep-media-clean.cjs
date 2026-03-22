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

function isSelectorDead(sel, dead) {
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.every(c => dead.has(c));
}

function deepMediaClean(cssFile, deadClasses) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedMediaBlocks = 0;
  let removedMediaRules = 0;
  let removedMediaLines = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    // Look for @media blocks
    if (t.startsWith('@media') || t.startsWith('@supports')) {
      // Find the entire @media block
      const mediaStart = i;
      let depth = 0;
      let mediaEnd = i;

      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        if (depth <= 0) {
          mediaEnd = j;
          break;
        }
      }

      // Extract all rules inside the media block
      const mediaLines = lines.slice(mediaStart, mediaEnd + 1);
      const mediaContent = mediaLines.join('\n');

      // Check if ALL rules inside are dead
      const innerRules = [...mediaContent.matchAll(/\.([a-zA-Z][\w-][^{]*)\{/g)];
      let allDead = true;
      let hasRules = false;

      for (const rule of innerRules) {
        const selText = rule[0].replace(/\s*\{$/, '');
        const sels = selText.split(',').map(s => s.trim()).filter(s => s);
        for (const s of sels) {
          const classes = [...s.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
          if (classes.length > 0) {
            hasRules = true;
            if (!classes.every(c => deadClasses.has(c))) {
              allDead = false;
              break;
            }
          }
        }
        if (!allDead) break;
      }

      if (hasRules && allDead) {
        // Entire @media block is dead
        removedMediaBlocks++;
        removedMediaLines += (mediaEnd - mediaStart + 1);
        i = mediaEnd + 1;
        continue;
      }

      // If not all dead, check for individual dead rules inside the media block
      // Parse inside the media block
      const mediaOutput = [lines[mediaStart]]; // @media line
      let k = mediaStart + 1;
      let innerRemoved = 0;

      while (k < mediaEnd) {
        const kt = lines[k].trim();

        // Check for dead rule inside media
        if (kt.startsWith('.') && !kt.startsWith('/*')) {
          // Collect selector
          let fullSel = kt;
          let selEnd = k;
          while (!fullSel.includes('{') && selEnd + 1 < mediaEnd) {
            selEnd++;
            fullSel += ' ' + lines[selEnd].trim();
          }

          const bIdx = fullSel.indexOf('{');
          if (bIdx >= 0) {
            const selPart = fullSel.substring(0, bIdx).trim();
            const sels = selPart.split(',').map(s => s.trim()).filter(s => s);
            const allSelsDead = sels.length > 0 && sels.every(s => isSelectorDead(s, deadClasses));

            if (allSelsDead) {
              // Skip this rule
              let ruleDepth = 0;
              let ruleEnd = k;
              for (let m = k; m < mediaEnd; m++) {
                for (const ch of lines[m]) {
                  if (ch === '{') ruleDepth++;
                  if (ch === '}') ruleDepth--;
                }
                ruleEnd = m;
                if (ruleDepth <= 0) break;
              }
              innerRemoved += (ruleEnd - k + 1);
              removedMediaRules++;
              k = ruleEnd + 1;
              continue;
            }
          }
        }

        mediaOutput.push(lines[k]);
        k++;
      }

      mediaOutput.push(lines[mediaEnd]); // closing }

      // Check if media block is now empty
      const innerContent = mediaOutput.slice(1, -1).join('\n').trim();
      if (!innerContent || innerContent === '') {
        // Empty after removing dead rules
        removedMediaBlocks++;
        removedMediaLines += (mediaEnd - mediaStart + 1);
      } else {
        for (const ml of mediaOutput) output.push(ml);
        removedMediaLines += innerRemoved;
      }

      i = mediaEnd + 1;
      continue;
    }

    output.push(lines[i]);
    i++;
  }

  let result = output.join('\n');
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
  console.log(cssFile + ':');
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  Removed ' + removedMediaBlocks + ' full @media blocks, ' + removedMediaRules + ' rules inside media');
  console.log('  Removed lines: ' + removedMediaLines);

  fs.writeFileSync(cssFile, result);
}

// DJ Lobby
const djText = getAllText([
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
]);
const djDead = findDeadClasses('src/styles/dj-lobby.css', djText);
console.log('DJ Lobby dead classes: ' + djDead.size);
deepMediaClean('src/styles/dj-lobby.css', djDead);

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
console.log('Live dead classes: ' + liveDead.size);
deepMediaClean('src/styles/live.css', liveDead);
