// Audit APIs for caching
const fs = require('fs');
const path = require('path');

function walkDir(dir) {
  let files = [];
  fs.readdirSync(dir).forEach(f => {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) files = files.concat(walkDir(full));
    else if (f.endsWith('.ts')) files.push(full);
  });
  return files;
}

const apiFiles = walkDir('src/pages/api');
const noCacheApis = [];
const withCacheApis = [];

apiFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const usesFirebase = /getDocument|queryCollection/.test(content);
  if (!usesFirebase) return;

  const hasKV = /kvGet|kvSet|initKVCache/.test(content);
  const hasD1 = /env\.DB|db\.prepare|\.bind\(/.test(content);
  const hasInternalCache = /cacheTime|cacheTTL|CACHE_TTL|cacheKey/.test(content);

  const shortPath = file.replace(/\\/g, '/').replace('src/pages/api/', '');

  if (!hasKV && !hasD1 && !hasInternalCache) {
    noCacheApis.push(shortPath);
  } else {
    const cacheTypes = [];
    if (hasKV) cacheTypes.push('KV');
    if (hasD1) cacheTypes.push('D1');
    if (hasInternalCache) cacheTypes.push('internal');
    withCacheApis.push({ file: shortPath, cache: cacheTypes.join('+') });
  }
});

console.log('=== APIs using Firebase WITHOUT any caching ===');
noCacheApis.forEach(f => console.log('  ' + f));
console.log('\nTotal uncached:', noCacheApis.length);

console.log('\n=== APIs using Firebase WITH caching ===');
withCacheApis.forEach(a => console.log(`  ${a.file} [${a.cache}]`));
console.log('\nTotal cached:', withCacheApis.length);
