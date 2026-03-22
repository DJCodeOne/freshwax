const fs = require('fs');
const file = process.argv[2] || 'src/styles/live.css';
const css = fs.readFileSync(file, 'utf8');
const lines = css.split('\n');
let depth = 0;
for (let i = 0; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }
  if (depth < 0) {
    console.log('UNBALANCED at line ' + (i+1) + ' (depth=' + depth + '): ' + lines[i].trim());
    // Show context
    for (let j = Math.max(0, i-5); j <= Math.min(lines.length-1, i+3); j++) {
      console.log((j === i ? '>>> ' : '    ') + (j+1) + ': ' + lines[j]);
    }
    break;
  }
}
if (depth === 0) console.log(file + ': All braces balanced');
else if (depth > 0) console.log(file + ': Missing ' + depth + ' closing brace(s)');
