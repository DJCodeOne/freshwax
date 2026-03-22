const fs = require('fs');

function analyzeMediaQueries(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const lines = css.split('\n');

  // Find all @media blocks
  const mediaBlocks = [];
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith('@media')) {
      const condition = t.replace(/\{.*$/, '').trim();
      const start = i;
      let depth = 0;
      let end = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        end = j;
        if (depth <= 0) break;
      }

      const content = lines.slice(start + 1, end).join('\n').trim();
      const size = end - start + 1;

      mediaBlocks.push({ condition, start: start + 1, end: end + 1, size, contentSize: content.length });
      i = end + 1;
    } else {
      i++;
    }
  }

  // Group by condition
  const groups = {};
  for (const mb of mediaBlocks) {
    if (!groups[mb.condition]) groups[mb.condition] = [];
    groups[mb.condition].push(mb);
  }

  console.log('\n' + filePath + ':');
  let totalDuplicateLines = 0;
  for (const [cond, blocks] of Object.entries(groups)) {
    if (blocks.length > 1) {
      const totalSize = blocks.reduce((s, b) => s + b.size, 0);
      // Overhead: each additional block adds ~2 lines (the @media and closing })
      const overhead = (blocks.length - 1) * 2;
      totalDuplicateLines += overhead;
      console.log('  ' + cond + ': ' + blocks.length + ' blocks, overhead ~' + overhead + ' lines');
      blocks.forEach(b => console.log('    L' + b.start + '-' + b.end + ' (' + b.size + ' lines, ' + b.contentSize + 'B content)'));
    }
  }
  console.log('  Total mergeable overhead: ~' + totalDuplicateLines + ' lines');
}

analyzeMediaQueries('src/styles/dj-lobby.css');
analyzeMediaQueries('src/styles/live.css');
