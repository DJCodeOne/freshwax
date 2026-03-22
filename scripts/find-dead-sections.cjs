const fs = require('fs');

function extractClassesFromRange(lines, start, end) {
  const classes = new Set();
  for (let i = start; i <= end && i < lines.length; i++) {
    for (const m of lines[i].matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      classes.add(m[1]);
    }
  }
  return classes;
}

function getUsedClasses(files) {
  const used = new Set();
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      // All word-boundary class-like strings
      for (const m of content.matchAll(/['"`.:\s]([a-z][\w-]+)/g)) {
        used.add(m[1]);
      }
    } catch {}
  }
  return used;
}

// Build used class sets
const djLobbyUsed = getUsedClasses([
  'src/pages/account/dj-lobby.astro',
  ...fs.readdirSync('public/dj-lobby').map(f => 'public/dj-lobby/' + f),
  'src/components/LiveChat.astro',
]);

const liveUsed = getUsedClasses([
  'src/pages/live.astro',
  ...fs.readdirSync('public/live').map(f => 'public/live/' + f),
  'src/components/LiveChat.astro',
  'src/components/LiveReactions.astro',
  'src/components/DailySchedule.astro',
]);

function analyzeFile(filePath, usedClasses) {
  const css = fs.readFileSync(filePath, 'utf8');
  const lines = css.split('\n');

  // Parse into rule blocks: selector + body
  const rules = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();

    // Skip comments, blank lines, @media/@supports/@keyframes
    if (!t || t.startsWith('/*') || t.startsWith('@')) {
      i++;
      continue;
    }

    // Check if this looks like a selector (has a class)
    if (t.match(/[.#a-zA-Z\[\*:>+~]/) && (t.includes('{') || t.endsWith(','))) {
      const ruleStart = i;
      // Collect full selector
      let selectorText = t;
      while (!selectorText.includes('{') && i + 1 < lines.length) {
        i++;
        selectorText += ' ' + lines[i].trim();
      }

      // Find closing brace
      let depth = 0;
      let ruleEnd = i;
      for (let j = ruleStart; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        ruleEnd = j;
        if (depth <= 0) break;
      }

      // Extract classes from selector
      const braceIdx = selectorText.indexOf('{');
      const selPart = braceIdx >= 0 ? selectorText.substring(0, braceIdx) : selectorText;
      const selClasses = [...selPart.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);

      const anyUsed = selClasses.some(c => usedClasses.has(c));
      if (!anyUsed && selClasses.length > 0) {
        rules.push({
          start: ruleStart,
          end: ruleEnd,
          size: ruleEnd - ruleStart + 1,
          selector: selPart.trim().substring(0, 60),
          classes: selClasses,
        });
      }

      i = ruleEnd + 1;
    } else {
      i++;
    }
  }

  // Sort by line number
  rules.sort((a, b) => b.size - a.size);

  let totalDeadLines = 0;
  console.log('\n' + filePath + ' - Dead rules still present:');
  rules.forEach(r => {
    if (r.size >= 3) {
      console.log(`  L${r.start + 1}-${r.end + 1} (${r.size}): ${r.selector}`);
      totalDeadLines += r.size;
    }
  });
  console.log('  Total dead lines: ' + totalDeadLines + ' / ' + lines.length);
  console.log('  Small dead rules (<3 lines): ' + rules.filter(r => r.size < 3).length);
}

analyzeFile('src/styles/dj-lobby.css', djLobbyUsed);
analyzeFile('src/styles/live.css', liveUsed);
