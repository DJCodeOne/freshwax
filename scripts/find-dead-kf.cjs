const fs = require('fs');

function findDeadKeyframes(cssFile, sourceFiles) {
  const css = fs.readFileSync(cssFile, 'utf8');

  // Extract all @keyframes names
  const keyframes = [];
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
    keyframes.push(m[1]);
  }

  // Check if each keyframe is referenced in animation properties
  const allText = css + '\n' + sourceFiles.map(f => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }).join('\n');

  const dead = [];
  const live = [];

  for (const kf of keyframes) {
    // Check animation: name or animation-name: name
    const animRe = new RegExp('animation(?:-name)?\\s*:[^;]*\\b' + kf.replace(/-/g, '\\-') + '\\b');
    if (animRe.test(allText)) {
      live.push(kf);
    } else {
      dead.push(kf);
    }
  }

  console.log(cssFile + ':');
  console.log('  Total @keyframes: ' + keyframes.length);
  console.log('  Live: ' + live.length + ' - ' + live.join(', '));
  console.log('  Dead: ' + dead.length + ' - ' + dead.join(', '));

  return dead;
}

function removeKeyframes(cssFile, deadKfs) {
  let css = fs.readFileSync(cssFile, 'utf8');
  const origLen = css.length;

  for (const kf of deadKfs) {
    // Find and remove the entire @keyframes block
    const lines = css.split('\n');
    const output = [];
    let i = 0;

    while (i < lines.length) {
      const t = lines[i].trim();
      if (t.startsWith('@keyframes') && t.includes(kf)) {
        // Verify exact name match
        const nameMatch = t.match(/@keyframes\s+([\w-]+)/);
        if (nameMatch && nameMatch[1] === kf) {
          // Skip entire block
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
      }
      output.push(lines[i]);
      i++;
    }
    css = output.join('\n');
  }

  // Collapse blank lines
  css = css.replace(/\n{3,}/g, '\n\n');

  const newLen = css.length;
  console.log('  Bytes: ' + origLen + ' -> ' + newLen + ' (-' + (origLen - newLen) + ')');

  fs.writeFileSync(cssFile, css);
}

// DJ Lobby
const djDead = findDeadKeyframes('src/styles/dj-lobby.css', [
  'src/pages/account/dj-lobby.astro',
  ...fs.readdirSync('public/dj-lobby').map(f => 'public/dj-lobby/' + f),
  'src/components/live/LiveChat.astro',
]);
if (djDead.length > 0) removeKeyframes('src/styles/dj-lobby.css', djDead);

console.log('');

// Live
const liveDead = findDeadKeyframes('src/styles/live.css', [
  'src/pages/live.astro',
  ...fs.readdirSync('public/live').map(f => 'public/live/' + f),
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
]);
if (liveDead.length > 0) removeKeyframes('src/styles/live.css', liveDead);
