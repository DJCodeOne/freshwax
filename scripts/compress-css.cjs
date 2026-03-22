const fs = require('fs');

function compressCSS(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origSize = css.length;
  const origLines = css.split('\n').length;

  // 1. Remove ALL single-line section comments (/* ... */)
  // Keep important comments (/*! */) and keep comments inside rules
  const lines = css.split('\n');
  const output = [];
  let prevWasComment = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    // Remove single-line comments that are section headers
    if (t.startsWith('/*') && t.endsWith('*/') && !t.startsWith('/*!')) {
      prevWasComment = true;
      continue;
    }

    // Remove multi-line comments
    if (t.startsWith('/*') && !t.endsWith('*/') && !t.startsWith('/*!')) {
      while (i < lines.length && !lines[i].includes('*/')) i++;
      prevWasComment = true;
      continue;
    }

    // Skip extra blank lines after removed comments
    if (t === '' && prevWasComment) continue;

    prevWasComment = false;
    output.push(lines[i]);
  }

  css = output.join('\n');

  // 2. Collapse 3+ blank lines to 1 blank line
  css = css.replace(/\n{3,}/g, '\n\n');

  // 3. Collapse 2+ blank lines to just 1
  css = css.replace(/\n\n+/g, '\n\n');

  // 4. Remove trailing whitespace from each line
  css = css.split('\n').map(l => l.trimEnd()).join('\n');

  // 5. Put single-property rules on one line: selector { property; }
  css = css.replace(/([^\n{]+)\{\n(\s+[^{}]+;)\n(\s*\})/g, (match, sel, prop, close) => {
    const propTrimmed = prop.trim();
    if (!propTrimmed.includes('\n') && propTrimmed.length < 80) {
      return sel.trimEnd() + ' { ' + propTrimmed + ' }';
    }
    return match;
  });

  // 6. Remove blank lines before closing }
  css = css.replace(/\n\n(\s*\})/g, '\n$1');

  // 7. Remove blank line between closing } and next selector
  css = css.replace(/\}\n\n(\s*[.#@a-zA-Z\[\*:>+~])/g, '}\n$1');

  const newSize = css.length;
  const newLines = css.split('\n').length;

  console.log(filePath + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (-' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origSize + ' -> ' + newSize + ' (-' + (origSize - newSize) + ', ' + ((origSize - newSize) * 100 / origSize).toFixed(1) + '%)');

  fs.writeFileSync(filePath, css);
}

compressCSS('src/styles/dj-lobby.css');
compressCSS('src/styles/live.css');
