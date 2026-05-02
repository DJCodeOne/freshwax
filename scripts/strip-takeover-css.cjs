// Strip takeover-related CSS rules from styles. For mixed selectors like
// `.preview-section,.takeover-section{...}` keep the non-takeover part;
// drop the rule entirely when every selector references takeover/claim/slot-available.
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['src/styles/dj-lobby.css', 'src/styles/live.css'];
const KILL = /(takeover|incoming-takeover|cancel-takeover|accept-takeover|decline-takeover|copy-takeover|slot-available|claim)/i;

for (const rel of FILES) {
  const file = path.resolve(__dirname, '..', rel);
  let src = fs.readFileSync(file, 'utf8');
  const before = src.length;
  let out = '';
  let i = 0;
  while (i < src.length) {
    // Find the next `{` that opens a rule body. We treat everything between the
    // previous boundary (start, or previous `}` / final newline) and that `{`
    // as the selector list. Skip over @-rules safely by leaving them alone —
    // we only inspect simple selectors.
    const open = src.indexOf('{', i);
    if (open === -1) { out += src.slice(i); break; }
    // Find matching close, accounting for nested braces (eg @media { .a{} }).
    let depth = 1;
    let j = open + 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    const selectorRaw = src.slice(i, open);
    const body = src.slice(open, j); // includes { ... }

    // @-rules: keep verbatim.
    if (selectorRaw.trim().startsWith('@')) {
      out += selectorRaw + body;
      i = j;
      continue;
    }

    // Filter selectors: drop any whose simple form matches KILL.
    const kept = selectorRaw.split(',').filter(s => !KILL.test(s));
    if (kept.length === 0) {
      // Rule fully eliminated — also swallow any leading whitespace/newline
      // so we don't leave a blank gap.
      i = j;
      // Trim trailing newline from out so consecutive removals collapse.
      out = out.replace(/[\t ]*\n?$/, m => m.endsWith('\n') ? '\n' : '');
      continue;
    }
    out += kept.join(',') + body;
    i = j;
  }
  fs.writeFileSync(file, out);
  console.log(`${rel}: ${before} -> ${out.length} (-${before - out.length} bytes)`);
}
