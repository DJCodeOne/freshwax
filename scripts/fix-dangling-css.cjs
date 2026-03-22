const fs = require('fs');

function findDanglingCommas(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const lines = css.split('\n');
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.endsWith(',')) {
      // Check what follows (skip blank lines)
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length) {
        const next = lines[j].trim();
        // Dangling comma before closing brace
        if (next === '}') {
          issues.push({ line: i + 1, text: line, nextLine: j + 1 });
        }
        // Dangling comma before another selector that also ends with comma and has no {
        // Check if there's a { before any } after this comma
        // Look for multi-line selectors where dead selectors were removed
      }
    }
  }
  return issues;
}

function fixDanglingCommas(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  let fixed = 0;

  // Pattern 1: selector line ending with comma, followed by blank/whitespace, then }
  // The whole dangling selector + } should become just }
  let prevCss;
  do {
    prevCss = css;
    // Remove lines that end with comma and are followed by only whitespace before }
    css = css.replace(/(\n\s*\.[a-zA-Z][\w-]*(?:[^\n{])*,)\s*\n(\s*\})/g, (match, sel, brace) => {
      fixed++;
      return '\n' + brace;
    });
  } while (css !== prevCss);

  // Pattern 2: multi-selector where last selector before { ends with trailing comma
  // e.g. ".foo,\n  .bar,\n  {\n" -> remove the trailing comma
  css = css.replace(/,(\s*\n\s*\{)/g, (match, rest) => {
    fixed++;
    return rest;
  });

  // Pattern 3: Remove empty rule blocks that now have no selectors
  // i.e., lone { ... } with nothing meaningful before {
  css = css.replace(/\n\s*\{\s*\n[^}]*\}/g, (match) => {
    // Only if there's truly nothing before the {
    if (match.trim().startsWith('{')) {
      fixed++;
      return '';
    }
    return match;
  });

  // Clean up consecutive blank lines (more than 2 in a row)
  css = css.replace(/\n{3,}/g, '\n\n');

  return { css, fixed };
}

// Process both files
for (const file of ['src/styles/live.css', 'src/styles/dj-lobby.css']) {
  console.log('\n=== ' + file + ' ===');
  const issues = findDanglingCommas(file);
  console.log('Dangling comma issues found: ' + issues.length);
  issues.forEach(i => console.log('  L' + i.line + ': ' + i.text));

  const { css, fixed } = fixDanglingCommas(file);
  console.log('Fixes applied: ' + fixed);
  fs.writeFileSync(file, css);
  console.log('File saved. Size: ' + css.length + ' bytes, ' + css.split('\n').length + ' lines');
}
