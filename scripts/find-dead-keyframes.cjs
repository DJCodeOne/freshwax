const fs = require('fs');

function findDeadKeyframes(cssFile, astroFile, jsDir) {
  const css = fs.readFileSync(cssFile, 'utf8');
  let checkContent = fs.readFileSync(astroFile, 'utf8');
  try {
    const jsFiles = fs.readdirSync(jsDir);
    for (const f of jsFiles) {
      checkContent += '\n' + fs.readFileSync(jsDir + '/' + f, 'utf8');
    }
  } catch(e) {}

  // Also add CSS content itself to check for animation: name references
  const allContent = css + '\n' + checkContent;

  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]);
  const unique = [...new Set(keyframes)];
  const dead = [];
  const lineMap = {};

  // Find line numbers for each @keyframes
  const lines = css.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/@keyframes\s+([\w-]+)/);
    if (match) {
      if (!lineMap[match[1]]) lineMap[match[1]] = [];
      lineMap[match[1]].push(i + 1);
    }
  }

  for (const kf of unique) {
    // Check if the name appears in animation properties (not just in @keyframes definition)
    // Remove the @keyframes definitions first, then check
    const withoutDefs = css.replace(/@keyframes\s+[\w-]+\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g, '');
    const usedInCssProps = withoutDefs.includes(kf);
    const usedInAstroJs = checkContent.includes(kf);

    if (!usedInCssProps && !usedInAstroJs) {
      dead.push(kf);
    }
  }

  console.log(cssFile + ': ' + unique.length + ' unique @keyframes, ' + dead.length + ' dead');
  dead.forEach(d => console.log('  DEAD @keyframes ' + d + ' (lines: ' + (lineMap[d] || []).join(', ') + ')'));
  unique.filter(k => !dead.includes(k)).forEach(k => {
    // Don't log used ones unless we want to see them
  });
}

findDeadKeyframes('src/styles/dj-lobby.css', 'src/pages/account/dj-lobby.astro', 'public/dj-lobby');
findDeadKeyframes('src/styles/live.css', 'src/pages/live.astro', 'public/live');
