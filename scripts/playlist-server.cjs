// Simple HTTP server to serve playlist MP3s, thumbnails, and metadata from H:\FreshWax-Backup
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8088;
const MUSIC_DIR = 'H:\\FreshWax-Backup';

// Cache for file list (rebuild every 5 minutes)
let fileCache = null;
let fileCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Get base name without extension (for matching mp3 to thumbnail/json)
function getBaseName(filename) {
  return filename.replace(/\.(mp3|webp|jpg|info\.json)$/i, '');
}

// Build file list with thumbnails and metadata
function buildFileList() {
  const now = Date.now();
  if (fileCache && (now - fileCacheTime) < CACHE_TTL) {
    return fileCache;
  }

  const allFiles = fs.readdirSync(MUSIC_DIR);
  const mp3Files = allFiles.filter(f => f.endsWith('.mp3'));
  const webpFiles = new Set(allFiles.filter(f => f.endsWith('.webp')).map(getBaseName));
  const jpgFiles = new Set(allFiles.filter(f => f.endsWith('.jpg')).map(getBaseName));
  const jsonFiles = new Set(allFiles.filter(f => f.endsWith('.info.json')).map(f => f.replace('.info.json', '')));

  const files = mp3Files.map(f => {
    const baseName = getBaseName(f);
    const displayName = baseName.replace(/\s*\[[^\]]+\]$/, ''); // Remove YouTube ID from display name

    // Find thumbnail (prefer webp, fallback to jpg)
    let thumbnail = null;
    if (webpFiles.has(baseName)) {
      thumbnail = `/thumb/${encodeURIComponent(baseName + '.webp')}`;
    } else if (jpgFiles.has(baseName)) {
      thumbnail = `/thumb/${encodeURIComponent(baseName + '.jpg')}`;
    }

    // Read metadata if available
    let duration = null;
    let uploader = null;
    if (jsonFiles.has(baseName)) {
      try {
        const jsonPath = path.join(MUSIC_DIR, baseName + '.info.json');
        const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        duration = meta.duration || null;
        uploader = meta.uploader || meta.channel || null;
      } catch (e) {
        // Ignore JSON read errors
      }
    }

    return {
      name: displayName,
      file: f,
      url: `/music/${encodeURIComponent(f)}`,
      thumbnail,
      duration,
      uploader
    };
  });

  fileCache = files;
  fileCacheTime = now;
  return files;
}

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  let filePath = decodeURIComponent(parsedUrl.pathname);

  // /list - return JSON list of all MP3s with thumbnails and metadata
  if (filePath === '/list') {
    try {
      const files = buildFileList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: files.length, files }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // /thumb/filename.webp or /thumb/filename.jpg - serve thumbnail images
  if (filePath.startsWith('/thumb/')) {
    const fileName = decodeURIComponent(filePath.replace('/thumb/', ''));
    const fullPath = path.join(MUSIC_DIR, fileName);

    // Security: ensure path is within MUSIC_DIR
    if (!fullPath.startsWith(MUSIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(fullPath, (err, stats) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Thumbnail not found');
        return;
      }

      const ext = path.extname(fileName).toLowerCase();
      const contentType = ext === '.webp' ? 'image/webp' : 'image/jpeg';

      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400' // Cache thumbnails for 24 hours
      });
      fs.createReadStream(fullPath).pipe(res);
    });
    return;
  }

  // /music/filename.mp3 - serve the file
  if (filePath.startsWith('/music/')) {
    const fileName = decodeURIComponent(filePath.replace('/music/', ''));
    const fullPath = path.join(MUSIC_DIR, fileName);

    // Security: ensure path is within MUSIC_DIR
    if (!fullPath.startsWith(MUSIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(fullPath, (err, stats) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }

      const range = req.headers.range;
      const fileSize = stats.size;

      if (range) {
        // Handle range requests for seeking
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'audio/mpeg'
        });

        fs.createReadStream(fullPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(fullPath).pipe(res);
      }
    });
    return;
  }

  // Root - show status
  if (filePath === '/') {
    const count = fs.readdirSync(MUSIC_DIR).filter(f => f.endsWith('.mp3')).length;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><title>FreshWax Playlist Server</title></head>
        <body style="font-family: system-ui; background: #111; color: #fff; padding: 2rem;">
          <h1>FreshWax Playlist Server</h1>
          <p>${count} MP3 files available</p>
          <p><a href="/list" style="color: #0af;">View file list (JSON)</a></p>
        </body>
      </html>
    `);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Playlist server running at http://localhost:${PORT}`);
  console.log(`  Serving files from: ${MUSIC_DIR}`);
  console.log(`\n  Endpoints:`);
  console.log(`    /        - Status page`);
  console.log(`    /list    - JSON list of all MP3s`);
  console.log(`    /music/* - Stream MP3 files`);
  console.log(`\n  Press Ctrl+C to stop\n`);
});
