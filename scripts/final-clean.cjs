const fs = require('fs');
const path = require('path');

// Comprehensive class usage checker
function getAllUsedClasses(files) {
  const used = new Set();

  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }

    // class="..." attributes
    for (const m of content.matchAll(/class=["']([^"']+)["']/g)) {
      for (const c of m[1].split(/\s+/)) {
        if (c && !c.startsWith('{') && !c.startsWith('$')) used.add(c);
      }
    }

    // classList.add/remove/toggle/contains
    for (const m of content.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*['"]([^'"]+)['"]/g)) {
      for (const c of m[1].split(/[\s,]+/)) used.add(c);
    }

    // querySelector('.class')
    for (const m of content.matchAll(/querySelector(?:All)?\(\s*['"]([^'"]+)['"]\)/g)) {
      for (const cm of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) used.add(cm[1]);
    }

    // closest('.class')
    for (const m of content.matchAll(/closest\(\s*['"]\.([a-zA-Z][\w-]+)['"]\)/g)) {
      used.add(m[1]);
    }

    // matches('.class')
    for (const m of content.matchAll(/matches\(\s*['"]\.?([a-zA-Z][\w-]+)['"]\)/g)) {
      used.add(m[1]);
    }

    // String literals that look like class names
    for (const m of content.matchAll(/['"`]([a-z][\w-]{2,})['"`]/g)) {
      used.add(m[1]);
    }

    // innerHTML/insertAdjacentHTML with class refs
    for (const m of content.matchAll(/(?:innerHTML|insertAdjacentHTML|outerHTML)[^;]*class=(?:\\?["'])([^"'\\]+)/g)) {
      for (const c of m[1].split(/\s+/)) used.add(c);
    }

    // Template literals
    for (const m of content.matchAll(/`[^`]*class=["'][^"']*?([a-z][\w-]+)/g)) {
      used.add(m[1]);
    }
  }

  return used;
}

function getJsFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js') || f.endsWith('.ts'))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

function isSelectorDead(selector, deadClasses) {
  const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.every(c => deadClasses.has(c));
}

function cleanFile(filePath, deadClasses) {
  const css = fs.readFileSync(filePath, 'utf8');
  const origSize = css.length;
  const origLines = css.split('\n').length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedRules = 0;
  let removedLines = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    // Skip @keyframes, @media - handle content inside
    if (t.startsWith('/*')) {
      output.push(lines[i]);
      i++;
      continue;
    }

    // Check if line starts a rule with dead selector
    if (t && !t.startsWith('@') && !t.startsWith('/*') && t.match(/[.#a-zA-Z]/) && (t.endsWith('{') || t.endsWith(','))) {
      // Collect full selector
      let selectorLines = [i];
      let fullSel = t;
      let j = i;

      while (!fullSel.includes('{') && j + 1 < lines.length) {
        j++;
        selectorLines.push(j);
        fullSel += ' ' + lines[j].trim();
      }

      const braceIdx = fullSel.indexOf('{');
      if (braceIdx >= 0) {
        const selPart = fullSel.substring(0, braceIdx).trim();
        const selectors = selPart.split(',').map(s => s.trim()).filter(s => s);

        // Check if ALL selectors in the comma group are dead
        if (selectors.length > 0 && selectors.every(s => isSelectorDead(s, deadClasses))) {
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

          const removed = endLine - i + 1;
          removedRules++;
          removedLines += removed;
          i = endLine + 1;
          continue;
        }

        // Check if SOME selectors are dead (mixed dead/live in comma groups)
        const liveSelectors = selectors.filter(s => !isSelectorDead(s, deadClasses));
        if (liveSelectors.length < selectors.length && liveSelectors.length > 0) {
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

          // Reconstruct rule with only live selectors
          const bodyStart = fullSel.indexOf('{');
          const afterBrace = fullSel.substring(bodyStart);

          // Get body lines
          const bodyLines = [];
          let foundBrace = false;
          for (let k = i; k <= endLine; k++) {
            if (!foundBrace && lines[k].includes('{')) {
              foundBrace = true;
              const afterB = lines[k].substring(lines[k].indexOf('{') + 1).trim();
              if (afterB) bodyLines.push('  ' + afterB);
              continue;
            }
            if (foundBrace) {
              bodyLines.push(lines[k]);
            }
          }

          // Reconstruct
          const indent = lines[i].match(/^(\s*)/)[1];
          const newSel = liveSelectors.join(',\n' + indent);
          output.push(indent + newSel + ' {');
          for (const bl of bodyLines) output.push(bl);

          i = endLine + 1;
          continue;
        }
      }
    }

    output.push(lines[i]);
    i++;
  }

  // Collapse 3+ blank lines to 2
  let result = output.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Remove empty @media blocks
  result = result.replace(/@media[^{]+\{\s*\}/g, '');

  // Remove orphaned comments (comment with only blank lines until next comment or })
  const finalLines = result.split('\n');
  const cleaned = [];
  for (let k = 0; k < finalLines.length; k++) {
    const ft = finalLines[k].trim();
    if (ft.startsWith('/*') && ft.endsWith('*/')) {
      let next = k + 1;
      while (next < finalLines.length && finalLines[next].trim() === '') next++;
      if (next >= finalLines.length || finalLines[next].trim() === '}' ||
          (finalLines[next].trim().startsWith('/*') && finalLines[next].trim().endsWith('*/'))) {
        continue; // orphaned comment
      }
    }
    cleaned.push(finalLines[k]);
  }

  result = cleaned.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  const newSize = result.length;
  const newLines = result.split('\n').length;

  console.log(filePath + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (-' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origSize + ' -> ' + newSize + ' (-' + (origSize - newSize) + ')');
  console.log('  Dead rules removed: ' + removedRules + ' (' + removedLines + ' lines)');

  fs.writeFileSync(filePath, result);
}

// DJ Lobby files
const djLobbyFiles = [
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...getJsFiles('public/dj-lobby'),
];
const djLobbyUsed = getAllUsedClasses(djLobbyFiles);

// Extract CSS classes that are NOT in the used set
const djCSS = fs.readFileSync('src/styles/dj-lobby.css', 'utf8');
const djCSSClasses = new Set([...djCSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
const djDeadClasses = new Set([...djCSSClasses].filter(c => !djLobbyUsed.has(c)));
console.log('DJ Lobby: ' + djCSSClasses.size + ' CSS classes, ' + djDeadClasses.size + ' dead, ' + djLobbyUsed.size + ' used');
console.log('Dead classes: ' + [...djDeadClasses].sort().join(', '));
console.log('');

// Live files
const liveFiles = [
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...getJsFiles('public/live'),
];
const liveUsed = getAllUsedClasses(liveFiles);

const liveCSS = fs.readFileSync('src/styles/live.css', 'utf8');
const liveCSSClasses = new Set([...liveCSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
const liveDeadClasses = new Set([...liveCSSClasses].filter(c => !liveUsed.has(c)));
console.log('Live: ' + liveCSSClasses.size + ' CSS classes, ' + liveDeadClasses.size + ' dead, ' + liveUsed.size + ' used');
console.log('Dead classes: ' + [...liveDeadClasses].sort().join(', '));
console.log('');

// Clean both files
cleanFile('src/styles/dj-lobby.css', djDeadClasses);
cleanFile('src/styles/live.css', liveDeadClasses);
