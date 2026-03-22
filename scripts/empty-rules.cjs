const fs = require('fs');

function removeEmptyRules(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;

  // Find and remove empty rules: selector { }
  // Single line: .foo { }
  let removed = 0;
  css = css.replace(/^[^\n@/*}]+\{[ \t]*\}\s*$/gm, (m) => {
    removed++;
    return '';
  });

  // Multi-line empty rules: selector {\n}
  css = css.replace(/^([^\n@/*}]+)\{\s*\n\s*\}/gm, (m) => {
    removed++;
    return '';
  });

  // Multi-line with only whitespace between { and }
  css = css.replace(/^([^\n@/*}]+)\{\s*\n(\s*\n)*\s*\}/gm, (m) => {
    removed++;
    return '';
  });

  css = css.replace(/\n{3,}/g, '\n\n');

  // Brace check
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log(filePath + ': ERROR!'); return; }
  }
  if (depth !== 0) { console.log(filePath + ': ERROR ' + depth + ' unclosed!'); return; }

  console.log(filePath + ': ' + origLen + ' -> ' + css.length + ' (-' + (origLen - css.length) + '), ' + removed + ' empty rules');
  fs.writeFileSync(filePath, css);
}

removeEmptyRules('src/styles/dj-lobby.css');
removeEmptyRules('src/styles/live.css');
