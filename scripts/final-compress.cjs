const fs = require('fs');

function finalCompress(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;

  // 1. Remove ALL remaining blank lines between rules
  // (Keep blank lines only before @media and @keyframes)
  const lines = css.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const nextT = (i + 1 < lines.length) ? lines[i + 1].trim() : '';

    // Skip blank lines UNLESS before a @media/@keyframes/@supports
    if (t === '') {
      if (nextT.startsWith('@media') || nextT.startsWith('@keyframes') || nextT.startsWith('@supports')) {
        out.push(''); // keep one blank line before @blocks
      }
      continue;
    }

    out.push(lines[i]);
  }
  css = out.join('\n');

  // 2. Merge short rules onto single lines
  // Match: selector{\n property;\n}  -> selector{ property; }
  css = css.replace(/([^\n]+)\{\n( [^\n{]+;)\n( *\})/g, (m, sel, prop, close) => {
    if (prop.trim().length < 60) {
      return sel + '{ ' + prop.trim() + ' }';
    }
    return m;
  });

  // 3. Merge 2-property rules onto fewer lines
  css = css.replace(/([^\n]+)\{\n( [^\n{]+;)\n( [^\n{]+;)\n( *\})/g, (m, sel, p1, p2, close) => {
    const total = p1.trim().length + p2.trim().length + 4;
    if (total < 80) {
      return sel + '{ ' + p1.trim() + ' ' + p2.trim() + ' }';
    }
    return m;
  });

  // 4. Remove space in "0px" -> "0"
  css = css.replace(/:\s*0px/g, ': 0');

  // 5. Remove trailing semicolons before }
  // Actually don't - browser compatibility

  const newLen = css.length;
  const newLines = css.split('\n').length;
  console.log(filePath + ': ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ', ' + ((origLen - newLen) * 100 / origLen).toFixed(1) + '%) ' + newLines + ' lines');

  fs.writeFileSync(filePath, css);
}

finalCompress('src/styles/dj-lobby.css');
finalCompress('src/styles/live.css');
