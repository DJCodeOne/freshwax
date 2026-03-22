const fs = require('fs');

function fixBrokenRules(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let fixed = 0;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    // Detect @media blocks that contain only selectors without { }
    if (t.startsWith('@media') || t.startsWith('@supports')) {
      // Find the end of this media block
      let depth = 0;
      let mediaEnd = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        mediaEnd = j;
        if (depth <= 0) break;
      }

      // Check content between opening and closing of media block
      const inner = lines.slice(i + 1, mediaEnd).join('\n').trim();

      // If inner content has no { }, it's broken (selectors without rule body)
      if (inner && !inner.includes('{')) {
        // The entire media block is broken, remove it
        fixed++;
        i = mediaEnd;
        continue;
      }

      // Also check for broken rules inside the media block
      // Pass through line by line
      output.push(lines[i]);

      for (let j = i + 1; j < mediaEnd; j++) {
        const jt = lines[j].trim();

        // If a line starts with . or # and the media block closing } follows
        // without any { in between, it's a broken selector
        if (jt.startsWith('.') || jt.startsWith('#')) {
          // Look ahead for { before the media closing }
          let hasOpenBrace = false;
          let hasComma = jt.endsWith(',');
          let k = j;

          while (k < mediaEnd) {
            if (lines[k].includes('{')) { hasOpenBrace = true; break; }
            if (lines[k].trim().endsWith(',')) hasComma = true;
            k++;
          }

          if (!hasOpenBrace) {
            // Skip all lines of this broken selector until mediaEnd
            fixed++;
            j = mediaEnd - 1; // will be incremented to mediaEnd
            continue;
          }
        }

        output.push(lines[j]);
      }

      output.push(lines[mediaEnd]);
      i = mediaEnd;
      continue;
    }

    // Also check for standalone broken selectors outside media
    if ((t.startsWith('.') || t.startsWith('#')) && !t.includes('{') && !t.includes('}') && !t.startsWith('/*')) {
      // Look ahead
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length) {
        const nextT = lines[j].trim();
        if (nextT === '}' || nextT.startsWith('@') || nextT.startsWith('/*')) {
          // Orphaned selector
          fixed++;
          continue;
        }
      }
    }

    output.push(lines[i]);
  }

  let result = output.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Remove empty media queries
  result = result.replace(/@media[^{]+\{\s*\}/g, '');
  result = result.replace(/@media[^{]+\{\s*\n\s*\}/g, '');

  // Brace check
  let depth = 0;
  for (const ch of result) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log(filePath + ': ERROR braces at depth ' + depth); return; }
  }
  if (depth !== 0) { console.log(filePath + ': ERROR ' + depth + ' unclosed!'); return; }

  console.log(filePath + ': ' + origLen + ' -> ' + result.length + ' (-' + (origLen - result.length) + '), ' + fixed + ' broken rules fixed');
  fs.writeFileSync(filePath, result);
}

fixBrokenRules('src/styles/dj-lobby.css');
fixBrokenRules('src/styles/live.css');
