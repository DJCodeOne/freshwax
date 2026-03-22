const fs = require('fs');

function cssStats(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const lines = css.split('\n');

  let commentBytes = 0;
  let blankLineBytes = 0;
  let indentBytes = 0;
  let propertyBytes = 0;
  let selectorBytes = 0;
  let braceBytes = 0;
  let inComment = false;
  let commentLines = 0;
  let blankLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Count leading whitespace
    const leadingSpaces = line.length - line.trimStart().length;
    indentBytes += leadingSpaces;

    if (trimmed === '') {
      blankLines++;
      blankLineBytes += line.length + 1; // +1 for newline
      continue;
    }

    // Comments
    if (trimmed.startsWith('/*')) inComment = true;
    if (inComment) {
      commentBytes += line.length + 1;
      commentLines++;
      if (trimmed.endsWith('*/')) inComment = false;
      continue;
    }

    // Property lines (contain :)
    if (trimmed.includes(':') && !trimmed.includes('{') && !trimmed.startsWith('@')) {
      propertyBytes += line.length + 1;
    }
    // Selector lines
    else if (trimmed.includes('{') || trimmed.endsWith(',')) {
      selectorBytes += line.length + 1;
    }
    // Closing braces
    else if (trimmed === '}') {
      braceBytes += line.length + 1;
    }
  }

  console.log('\n' + filePath + ' (' + css.length + ' bytes, ' + lines.length + ' lines):');
  console.log('  Comments:     ' + commentBytes + ' bytes (' + commentLines + ' lines, ' + (commentBytes * 100 / css.length).toFixed(1) + '%)');
  console.log('  Blank lines:  ' + blankLineBytes + ' bytes (' + blankLines + ' lines, ' + (blankLineBytes * 100 / css.length).toFixed(1) + '%)');
  console.log('  Indentation:  ' + indentBytes + ' bytes (' + (indentBytes * 100 / css.length).toFixed(1) + '%)');
  console.log('  Properties:   ' + propertyBytes + ' bytes (' + (propertyBytes * 100 / css.length).toFixed(1) + '%)');
  console.log('  Selectors:    ' + selectorBytes + ' bytes (' + (selectorBytes * 100 / css.length).toFixed(1) + '%)');
  console.log('  Close braces: ' + braceBytes + ' bytes (' + (braceBytes * 100 / css.length).toFixed(1) + '%)');

  // Count @media blocks
  let mediaBlocks = 0;
  let mediaLines = 0;
  let inMedia = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('@media')) {
      mediaBlocks++;
      inMedia = true;
      depth = 0;
    }
    if (inMedia) {
      mediaLines++;
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth <= 0) inMedia = false;
    }
  }
  console.log('  @media blocks: ' + mediaBlocks + ' (' + mediaLines + ' lines)');

  // Count @keyframes
  let keyframeBlocks = 0;
  let keyframeLines = 0;
  let inKF = false;
  depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('@keyframes')) {
      keyframeBlocks++;
      inKF = true;
      depth = 0;
    }
    if (inKF) {
      keyframeLines++;
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth <= 0) inKF = false;
    }
  }
  console.log('  @keyframes:    ' + keyframeBlocks + ' (' + keyframeLines + ' lines)');
}

cssStats('src/styles/dj-lobby.css');
cssStats('src/styles/live.css');
