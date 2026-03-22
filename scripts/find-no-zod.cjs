const fs = require('fs');
const path = require('path');

function walk(dir, results = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, results);
    else if (f.endsWith('.ts')) results.push(p);
  }
  return results;
}

const files = walk('src/pages/api');
const noZod = files.filter(f => {
  const c = fs.readFileSync(f, 'utf8');
  const hasJson = c.includes('request.json()');
  const hasZod = /from\s+['"]zod['"]/.test(c);
  const hasPost = /export\s+(async\s+function|const|function)\s+POST/.test(c);
  return hasJson && !hasZod && hasPost;
});

console.log(`Found ${noZod.length} POST endpoints with request.json() but no Zod:\n`);
noZod.forEach(f => console.log(f));
