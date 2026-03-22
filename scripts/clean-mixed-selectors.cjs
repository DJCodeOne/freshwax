const fs = require('fs');
const path = require('path');

function getJsFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js') || f.endsWith('.ts'))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

function getAllText(files) {
  return files.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
}

function findDeadClasses(cssFile, sourceText) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const classes = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(m[1]);
  const dead = new Set();
  for (const c of classes) {
    if (!sourceText.includes(c)) dead.add(c);
  }
  return dead;
}

function isSelectorDead(sel, deadClasses) {
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.every(c => deadClasses.has(c));
}

function cleanMixedSelectors(cssFile, deadClasses) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let fixedCount = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    // Look for selector lines with commas that contain dead selectors
    if (t && !t.startsWith('/*') && !t.startsWith('@') && t.match(/\./) && (t.includes(',') || t.endsWith('{'))) {
      // Collect full selector
      let selLines = [];
      let fullText = '';
      let j = i;

      while (j < lines.length) {
        selLines.push(j);
        fullText += (fullText ? ' ' : '') + lines[j].trim();
        if (fullText.includes('{')) break;
        j++;
      }

      const braceIdx = fullText.indexOf('{');
      if (braceIdx >= 0 && fullText.includes(',')) {
        const selPart = fullText.substring(0, braceIdx).trim();
        const afterBrace = fullText.substring(braceIdx);
        const selectorList = selPart.split(',').map(s => s.trim()).filter(s => s);

        if (selectorList.length > 1) {
          const liveSelectors = selectorList.filter(s => !isSelectorDead(s, deadClasses));
          const deadSelectors = selectorList.filter(s => isSelectorDead(s, deadClasses));

          if (deadSelectors.length > 0 && liveSelectors.length > 0) {
            // Rewrite with only live selectors
            const indent = lines[i].match(/^(\s*)/)[1];

            // Find end of rule block
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

            // Get body lines (everything between { and })
            let bodyContent = '';
            let foundOpen = false;
            for (let k = i; k <= endLine; k++) {
              if (!foundOpen) {
                const bIdx = lines[k].indexOf('{');
                if (bIdx >= 0) {
                  foundOpen = true;
                  const rest = lines[k].substring(bIdx + 1).trim();
                  if (rest && rest !== '}') bodyContent += rest + '\n';
                }
              } else if (k === endLine) {
                // Last line - take content before }
                const cIdx = lines[k].lastIndexOf('}');
                if (cIdx >= 0) {
                  const before = lines[k].substring(0, cIdx).trim();
                  if (before) bodyContent += before + '\n';
                }
              } else {
                bodyContent += lines[k] + '\n';
              }
            }

            // Reconstruct
            if (liveSelectors.length === 1) {
              output.push(indent + liveSelectors[0] + ' {');
            } else {
              output.push(indent + liveSelectors.join(',\n' + indent) + ' {');
            }
            // Add body lines
            const bodyLines = bodyContent.split('\n').filter(l => l.trim());
            for (const bl of bodyLines) output.push(bl);
            output.push(indent + '}');

            fixedCount++;
            i = endLine + 1;
            continue;
          }
        }
      }
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
    if (depth < 0) {
      console.log('ERROR: Unbalanced braces in ' + cssFile + '! Not saving.');
      return;
    }
  }
  if (depth !== 0) {
    console.log('ERROR: ' + depth + ' unclosed braces in ' + cssFile + '! Not saving.');
    return;
  }

  const newLen = result.length;
  console.log(cssFile + ':');
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  Mixed selectors cleaned: ' + fixedCount);

  fs.writeFileSync(cssFile, result);
}

// DJ Lobby
const djText = getAllText([
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
]);
const djDead = findDeadClasses('src/styles/dj-lobby.css', djText);
cleanMixedSelectors('src/styles/dj-lobby.css', djDead);

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
cleanMixedSelectors('src/styles/live.css', liveDead);
