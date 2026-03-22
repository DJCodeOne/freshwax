const fs = require('fs');

// Comprehensive class usage checker
function getAllUsedClasses(astroFile, jsDir, components) {
  const used = new Set();
  const files = [astroFile, ...components];

  try {
    const jsFiles = fs.readdirSync(jsDir).map(f => jsDir + '/' + f);
    files.push(...jsFiles);
  } catch {}

  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');

      // class="..." attributes - all classes
      for (const m of content.matchAll(/class=["']([^"']+)["']/g)) {
        for (const c of m[1].split(/\s+/)) {
          if (c && !c.startsWith('{') && !c.startsWith('$')) used.add(c);
        }
      }

      // classList.add/remove/toggle/contains
      for (const m of content.matchAll(/classList\.(?:add|remove|toggle|contains)\(['"]([^'"]+)['"]/g)) {
        for (const c of m[1].split(/\s+/)) used.add(c);
      }

      // .className = '...' or className: '...'
      for (const m of content.matchAll(/(?:className|\.className)\s*[=:]\s*['"]([^'"]+)['"]/g)) {
        for (const c of m[1].split(/\s+/)) used.add(c);
      }

      // querySelector/querySelectorAll with . class refs
      for (const m of content.matchAll(/querySelector(?:All)?\(['"]([^'"]+)['"]\)/g)) {
        for (const cm of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) {
          used.add(cm[1]);
        }
      }

      // closest('.class-name')
      for (const m of content.matchAll(/closest\(['"]\.([a-zA-Z][\w-]+)['"]\)/g)) {
        used.add(m[1]);
      }

      // String literals that look like class names (in JS)
      for (const m of content.matchAll(/['"`]([a-z][\w-]{2,})['"`]/g)) {
        used.add(m[1]);
      }

      // Template literals with class names
      for (const m of content.matchAll(/`[^`]*\bclass=["'][^"']*\b([a-z][\w-]+)/g)) {
        used.add(m[1]);
      }

      // innerHTML/insertAdjacentHTML with class refs
      for (const m of content.matchAll(/(?:innerHTML|insertAdjacentHTML)[^;]*class=(?:\\?["'])([^"'\\]+)/g)) {
        for (const c of m[1].split(/\s+/)) used.add(c);
      }
    } catch {}
  }

  return used;
}

function getCSSClasses(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const lines = css.split('\n');
  const rules = [];

  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();

    // Skip comments
    if (t.startsWith('/*')) {
      while (i < lines.length && !lines[i].includes('*/')) i++;
      i++;
      continue;
    }

    // Skip @keyframes
    if (t.startsWith('@keyframes')) {
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

    // Skip @media (we handle rules inside)
    if (t.startsWith('@media') || t.startsWith('@supports')) {
      i++;
      continue;
    }

    // Check for selector lines
    if (t && !t.startsWith('@') && (t.match(/[.#]/) || t.match(/^[a-z]/)) && !t.startsWith('/*')) {
      // Collect full selector
      let selText = t;
      let startLine = i;
      while (!selText.includes('{') && i + 1 < lines.length) {
        i++;
        selText += ' ' + lines[i].trim();
      }

      if (selText.includes('{')) {
        const braceIdx = selText.indexOf('{');
        const selPart = selText.substring(0, braceIdx).trim();

        // Extract classes from selector
        const classes = [...selPart.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);

        // Find closing brace
        let depth = 0;
        let endLine = i;
        for (let j = startLine; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
          }
          endLine = j;
          if (depth <= 0) break;
        }

        if (classes.length > 0) {
          const bodyLines = endLine - startLine + 1;
          const bodyBytes = lines.slice(startLine, endLine + 1).join('\n').length;
          rules.push({
            start: startLine,
            end: endLine,
            lines: bodyLines,
            bytes: bodyBytes,
            selector: selPart.substring(0, 80),
            classes,
          });
        }

        i = endLine + 1;
        continue;
      }
    }

    i++;
  }

  return rules;
}

function analyzeDeadRules(filePath, usedClasses) {
  const rules = getCSSClasses(filePath);
  const deadRules = rules.filter(r => !r.classes.some(c => usedClasses.has(c)));

  let totalDeadBytes = 0;
  let totalDeadLines = 0;

  deadRules.sort((a, b) => b.bytes - a.bytes);

  console.log('\n' + filePath + ':');
  console.log('Total rules: ' + rules.length);
  console.log('Dead rules: ' + deadRules.length);

  for (const r of deadRules) {
    totalDeadBytes += r.bytes;
    totalDeadLines += r.lines;
    if (r.lines >= 3) {
      console.log('  L' + (r.start+1) + '-' + (r.end+1) + ' (' + r.lines + ' lines, ' + r.bytes + 'B): ' + r.selector);
    }
  }

  console.log('Total dead: ' + totalDeadLines + ' lines, ' + totalDeadBytes + ' bytes');
}

const djLobbyUsed = getAllUsedClasses(
  'src/pages/account/dj-lobby.astro',
  'public/dj-lobby',
  ['src/components/LiveChat.astro']
);
console.log('DJ Lobby used classes: ' + djLobbyUsed.size);

const liveUsed = getAllUsedClasses(
  'src/pages/live.astro',
  'public/live',
  ['src/components/LiveChat.astro', 'src/components/LiveReactions.astro', 'src/components/DailySchedule.astro']
);
console.log('Live used classes: ' + liveUsed.size);

analyzeDeadRules('src/styles/dj-lobby.css', djLobbyUsed);
analyzeDeadRules('src/styles/live.css', liveUsed);
