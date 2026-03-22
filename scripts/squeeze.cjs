const fs = require('fs');

function squeeze(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;

  // 1. Shorten hex colors: #aabbcc -> #abc
  css = css.replace(/#([0-9a-fA-F])\1([0-9a-fA-F])\2([0-9a-fA-F])\3\b/g, '#$1$2$3');

  // 2. Remove units from zero: 0px, 0rem, 0em -> 0
  css = css.replace(/:\s*0(?:px|rem|em|%|vh|vw)/g, ': 0');
  css = css.replace(/\s0(?:px|rem|em|%|vh|vw)\s/g, ' 0 ');
  css = css.replace(/\s0(?:px|rem|em|%|vh|vw);/g, ' 0;');
  css = css.replace(/\s0(?:px|rem|em|%|vh|vw),/g, ' 0,');

  // 3. Remove space after colons in properties
  css = css.replace(/:\s+/g, ': ');

  // 4. Remove trailing whitespace
  css = css.split('\n').map(l => l.trimEnd()).join('\n');

  // 5. Count some stats
  const importantCount = (css.match(/!important/g) || []).length;
  const webkitCount = (css.match(/-webkit-/g) || []).length;

  const newLen = css.length;
  console.log(filePath + ':');
  console.log('  ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');
  console.log('  !important: ' + importantCount + ', -webkit-: ' + webkitCount);

  fs.writeFileSync(filePath, css);
}

squeeze('src/styles/dj-lobby.css');
squeeze('src/styles/live.css');
