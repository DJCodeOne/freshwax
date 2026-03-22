const fs = require('fs');

function fixDanglingCommas(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;
  let fixed = 0;

  // Pattern 1: selector ending with comma, followed by blank lines, then }
  // This means the next selector in the group was removed, leaving a dangling comma
  css = css.replace(/,\s*\n(\s*\n)*(\s*\})/g, (match, blank, close) => {
    fixed++;
    return '\n' + close;
  });

  // Pattern 2: selector ending with comma at end of line, next line is }
  css = css.replace(/,\s*\n(\s*\})/g, (match, close) => {
    fixed++;
    return '\n' + close;
  });

  // Pattern 3: Single selector ending with comma before @media or another rule
  // e.g. .foo,\n @media... (dangling)
  css = css.replace(/,\s*\n(\s*@)/g, (match, at) => {
    fixed++;
    return '\n' + at;
  });

  // Pattern 4: Comma at the end of a selector line before just whitespace and }
  const lines = css.split('\n');
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.endsWith(',')) {
      // Look ahead for } (with optional blank lines)
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].trim() === '}') {
        // Remove trailing comma
        output.push(lines[i].replace(/,\s*$/, ''));
        fixed++;
        continue;
      }
    }
    output.push(lines[i]);
  }
  css = output.join('\n');

  // Remove lines that are ONLY a comma followed by whitespace
  css = css.replace(/^\s*,\s*$/gm, '');

  // Clean up blank lines
  css = css.replace(/\n{3,}/g, '\n\n');

  // Brace check
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log(filePath + ': ERROR braces!'); return; }
  }
  if (depth !== 0) { console.log(filePath + ': ERROR ' + depth + ' unclosed!'); return; }

  console.log(filePath + ': ' + origLen + ' -> ' + css.length + ' (-' + (origLen - css.length) + '), ' + fixed + ' fixes');
  fs.writeFileSync(filePath, css);
}

fixDanglingCommas('src/styles/dj-lobby.css');
fixDanglingCommas('src/styles/live.css');
