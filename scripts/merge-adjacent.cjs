const fs = require('fs');

function mergeAdjacentMedia(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let mergedCount = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (t.startsWith('@media') || t.startsWith('@supports')) {
      const condition = t.replace(/\{.*$/, '').trim();

      // Find end of this block
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

      // Collect content (between opening { and closing })
      const content = lines.slice(i + 1, end);

      // Check if next non-blank line starts the same @media
      let next = end + 1;
      while (next < lines.length && lines[next].trim() === '') next++;

      if (next < lines.length) {
        const nextT = lines[next].trim();
        const nextCond = nextT.replace(/\{.*$/, '').trim();

        if (nextCond === condition) {
          // Merge! Find end of next block
          let depth2 = 0;
          let end2 = next;
          for (let j = next; j < lines.length; j++) {
            for (const ch of lines[j]) {
              if (ch === '{') depth2++;
              if (ch === '}') depth2--;
            }
            end2 = j;
            if (depth2 <= 0) break;
          }

          const content2 = lines.slice(next + 1, end2);

          // Write merged block
          output.push(lines[i]); // @media ... {
          for (const cl of content) output.push(cl);
          for (const cl of content2) output.push(cl);
          output.push(lines[end]); // }

          mergedCount++;
          i = end2 + 1;
          continue;
        }
      }

      // No merge, pass through
      for (let j = i; j <= end; j++) output.push(lines[j]);
      i = end + 1;
      continue;
    }

    output.push(lines[i]);
    i++;
  }

  let result = output.join('\n');

  // Brace check
  let d = 0;
  for (const ch of result) {
    if (ch === '{') d++;
    if (ch === '}') d--;
    if (d < 0) { console.log(filePath + ': ERROR!'); return; }
  }
  if (d !== 0) { console.log(filePath + ': ERROR ' + d + ' unclosed!'); return; }

  console.log(filePath + ': ' + origLen + ' -> ' + result.length + ' (-' + (origLen - result.length) + '), merged ' + mergedCount);
  fs.writeFileSync(filePath, result);
}

// Run multiple passes until no more merges
function mergeAll(filePath) {
  let prevSize = 0;
  let totalMerged = 0;
  while (true) {
    const size = fs.readFileSync(filePath, 'utf8').length;
    if (size === prevSize) break;
    prevSize = size;
    mergeAdjacentMedia(filePath);
  }
}

mergeAll('src/styles/dj-lobby.css');
mergeAll('src/styles/live.css');
