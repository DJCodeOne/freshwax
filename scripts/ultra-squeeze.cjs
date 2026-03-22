const fs = require('fs');

function ultraSqueeze(filePath) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;

  // 1. Remove space between selector and { when selector is short
  // .foo { -> .foo{
  // Already done

  // 2. Remove unnecessary spaces in selectors
  // .foo > .bar -> .foo>.bar
  css = css.replace(/ > /g, '>');
  css = css.replace(/ \+ /g, '+');
  css = css.replace(/ ~ /g, '~');

  // 3. Shorten 'transparent' -> rgba(0,0,0,0) is longer, skip
  // 4. Shorten 'none' -> can't

  // 5. Merge two-line single-property rules
  const lines = css.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const next = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
    const next2 = (i + 2 < lines.length) ? lines[i + 2].trim() : '';

    // Pattern: selector{ \n  single-prop; \n }
    if (t.endsWith('{') && next.endsWith(';') && next2 === '}') {
      if (next.length < 70) {
        out.push(t + ' ' + next + ' }');
        i += 2;
        continue;
      }
    }

    // Pattern: two properties that are short enough
    if (t.endsWith('{') && next.endsWith(';') && next2.endsWith(';')) {
      const next3 = (i + 3 < lines.length) ? lines[i + 3].trim() : '';
      if (next3 === '}' && next.length + next2.length < 70) {
        out.push(t + ' ' + next + ' ' + next2 + ' }');
        i += 3;
        continue;
      }
    }

    out.push(lines[i]);
  }
  css = out.join('\n');

  // 6. Remove "sans-serif" from font-family when 'Inter' is specified
  // Actually, don't - it's a fallback

  // 7. Remove empty lines between } and next rule inside @media
  // Already done by final-compress

  const newLen = css.length;
  console.log(filePath + ': ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');

  // Brace check
  let d = 0;
  for (const ch of css) {
    if (ch === '{') d++;
    if (ch === '}') d--;
    if (d < 0) { console.log('  ERROR!'); return; }
  }
  if (d !== 0) { console.log('  ERROR ' + d + ' unclosed!'); return; }

  fs.writeFileSync(filePath, css);
}

ultraSqueeze('src/styles/dj-lobby.css');
ultraSqueeze('src/styles/live.css');
