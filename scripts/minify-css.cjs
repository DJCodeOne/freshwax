const fs = require('fs');

function minifyCSS(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origSize = css.length;
  const origLines = css.split('\n').length;

  // 1. Remove all comments (preserving important ones with !)
  css = css.replace(/\/\*(?!\s*!)[\s\S]*?\*\//g, '');

  // 2. Remove leading/trailing whitespace from each line
  css = css.split('\n').map(l => l.trim()).join('\n');

  // 3. Collapse multiple blank lines to single
  css = css.replace(/\n{2,}/g, '\n');

  // 4. Remove blank lines before }
  css = css.replace(/\n+\}/g, '\n}');

  // 5. Remove blank lines after {
  css = css.replace(/\{\n+/g, '{\n');

  // 6. Put single-property rules on one line
  // Match: selector {\n  property: value;\n}
  css = css.replace(/([^{]+)\{\n([^{}]+)\n\}/g, (match, selector, body) => {
    const props = body.trim().split('\n').map(p => p.trim()).filter(p => p);
    if (props.length === 1) {
      return selector.trim() + ' { ' + props[0] + ' }';
    }
    return match;
  });

  // 7. Remove unnecessary semicolons before }
  // (keep them - it's better for maintainability)

  const newSize = css.length;
  const newLines = css.split('\n').length;

  console.log(filePath + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (removed ' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origSize + ' -> ' + newSize + ' (saved ' + (origSize - newSize) + ', ' + ((origSize - newSize) * 100 / origSize).toFixed(1) + '%)');

  fs.writeFileSync(filePath, css);
}

minifyCSS('src/styles/dj-lobby.css');
minifyCSS('src/styles/live.css');
