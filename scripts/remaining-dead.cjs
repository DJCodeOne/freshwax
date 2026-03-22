const fs = require('fs');

function check(cssFile, sourceFiles) {
  const text = sourceFiles.map(f => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }).join('\n');

  const css = fs.readFileSync(cssFile, 'utf8');
  const classes = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(m[1]);

  const dead = [...classes].filter(c => !text.includes(c)).sort();
  console.log(cssFile + ': ' + dead.length + ' dead classes remaining');
  dead.forEach(c => {
    // Find where it's used in CSS
    const lines = css.split('\n');
    const usages = [];
    lines.forEach((l, i) => {
      if (l.includes('.' + c) && !l.trim().startsWith('/*')) usages.push(i + 1);
    });
    console.log('  ' + c + ' (lines: ' + usages.join(', ') + ')');
  });
}

check('src/styles/dj-lobby.css', [
  'src/pages/account/dj-lobby.astro',
  'src/components/live/LiveChat.astro',
  ...fs.readdirSync('public/dj-lobby').map(f => 'public/dj-lobby/' + f),
]);

console.log('');

check('src/styles/live.css', [
  'src/pages/live.astro',
  'src/components/live/LiveChat.astro',
  'src/components/live/LiveReactions.astro',
  'src/components/DailySchedule.astro',
  ...fs.readdirSync('public/live').map(f => 'public/live/' + f),
]);
