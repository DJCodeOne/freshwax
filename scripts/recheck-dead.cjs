const fs = require('fs');

function extractClasses(cssFile) {
  const css = fs.readFileSync(cssFile, 'utf8');
  const classes = new Set();
  // Match all class selectors
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    classes.add(m[1]);
  }
  return classes;
}

function findUsedClasses(files) {
  const used = new Set();
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      // Match class="..." and classList
      for (const m of content.matchAll(/(?:class(?:Name)?=["'`]|classList\.[a-z]+\(["'`])([^"'`]+)/g)) {
        for (const c of m[1].split(/\s+/)) {
          if (c) used.add(c.replace(/[{}$]/g, ''));
        }
      }
      // Match .className in JS
      for (const m of content.matchAll(/\.classList\.(?:add|remove|toggle|contains)\(['"]([^'"]+)['"]\)/g)) {
        for (const c of m[1].split(/\s+/)) {
          if (c) used.add(c);
        }
      }
      // Match 'class-name' strings that could be classes
      for (const m of content.matchAll(/['"]([a-z][\w-]+)['"]/g)) {
        used.add(m[1]);
      }
      // Match className = 'xxx'
      for (const m of content.matchAll(/className\s*[=:]\s*['"]([^'"]+)['"]/g)) {
        for (const c of m[1].split(/\s+/)) {
          if (c) used.add(c);
        }
      }
    } catch (e) {
      // file not found
    }
  }
  return used;
}

// DJ Lobby
const djLobbyClasses = extractClasses('src/styles/dj-lobby.css');
const djLobbyJsFiles = fs.readdirSync('public/dj-lobby').map(f => 'public/dj-lobby/' + f);
const djLobbyUsed = findUsedClasses([
  'src/pages/account/dj-lobby.astro',
  ...djLobbyJsFiles,
  'src/components/LiveChat.astro',
]);
const djLobbyDead = [...djLobbyClasses].filter(c => !djLobbyUsed.has(c)).sort();
console.log('dj-lobby.css: ' + djLobbyClasses.size + ' classes, ' + djLobbyDead.length + ' dead (' + (djLobbyDead.length * 100 / djLobbyClasses.size).toFixed(1) + '%)');
console.log('Dead classes:', djLobbyDead.join(', '));

console.log('');

// Live
const liveClasses = extractClasses('src/styles/live.css');
const liveJsFiles = fs.readdirSync('public/live').map(f => 'public/live/' + f);
const liveUsed = findUsedClasses([
  'src/pages/live.astro',
  ...liveJsFiles,
  'src/components/LiveChat.astro',
  'src/components/LiveReactions.astro',
  'src/components/DailySchedule.astro',
]);
const liveDead = [...liveClasses].filter(c => !liveUsed.has(c)).sort();
console.log('live.css: ' + liveClasses.size + ' classes, ' + liveDead.length + ' dead (' + (liveDead.length * 100 / liveClasses.size).toFixed(1) + '%)');
console.log('Dead classes:', liveDead.join(', '));
