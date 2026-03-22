const fs = require('fs');

function compress2(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origSize = css.length;

  // 1. Replace 2-space indent with 1 space
  // This typically applies to property lines inside rules
  const lines = css.split('\n');
  const out = lines.map(line => {
    // Count leading spaces
    const match = line.match(/^( +)/);
    if (match) {
      const spaces = match[1].length;
      // Replace each 2 spaces of indent with 1
      const newIndent = Math.ceil(spaces / 2);
      return ' '.repeat(newIndent) + line.trimStart();
    }
    return line;
  });
  css = out.join('\n');

  // 2. Remove space before { in selectors
  css = css.replace(/ \{$/gm, '{');

  // 3. Remove space after : in properties (risky, skip for now)
  // css = css.replace(/:\s+/g, ':');

  // 4. Remove the blank line between rules (keep one)
  // Already done

  const newSize = css.length;
  console.log(filePath + ': ' + origSize + ' -> ' + newSize + ' (-' + (origSize - newSize) + ', ' + ((origSize - newSize) * 100 / origSize).toFixed(1) + '%)');

  fs.writeFileSync(filePath, css);
}

compress2('src/styles/dj-lobby.css');
compress2('src/styles/live.css');
