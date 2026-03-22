const fs = require('fs');

function findAndRemoveDeadKF(cssFile, sourceFiles) {
  let css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;

  // Find all @keyframes
  const kfs = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]);

  // Build combined text from CSS (remaining rules) + source files
  const sourceText = sourceFiles.map(f => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }).join('\n');

  const dead = [];
  for (const kf of kfs) {
    // Check if this keyframe is referenced in animation: or animation-name: in current CSS
    const re = new RegExp('animation(?:-name)?\\s*:[^;]*\\b' + kf.replace(/-/g, '\\-') + '\\b');
    const inCSS = re.test(css);
    const inSource = re.test(sourceText);
    // Also check source for just the name in case of JS animation API
    const nameInSource = sourceText.includes(kf);

    if (!inCSS && !nameInSource) {
      dead.push(kf);
    }
  }

  console.log(cssFile + ':');
  console.log('  Total @keyframes: ' + kfs.length);
  console.log('  Dead: ' + dead.length + ' - ' + dead.join(', '));

  if (dead.length === 0) return;

  // Remove dead keyframes
  for (const kf of dead) {
    const lines = css.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      const m = t.match(/@keyframes\s+([\w-]+)/);
      if (m && m[1] === kf) {
        let depth = 0;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
          }
          if (depth <= 0) { i = j + 1; break; }
        }
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    css = out.join('\n');
  }

  css = css.replace(/\n{3,}/g, '\n\n');

  // Brace check
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log('  ERROR: unbalanced!'); return; }
  }
  if (depth !== 0) { console.log('  ERROR: ' + depth + ' unclosed!'); return; }

  console.log('  Bytes: ' + origLen + ' -> ' + css.length + ' (-' + (origLen - css.length) + ')');
  fs.writeFileSync(cssFile, css);
}

findAndRemoveDeadKF('src/styles/dj-lobby.css', [
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...fs.readdirSync('public/dj-lobby').map(f => 'public/dj-lobby/' + f),
]);

console.log('');

findAndRemoveDeadKF('src/styles/live.css', [
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...fs.readdirSync('public/live').map(f => 'public/live/' + f),
]);
