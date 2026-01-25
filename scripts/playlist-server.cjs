// Robust HTTP server to serve playlist MP3s, thumbnails, and metadata
// Features: Auto-recovery, error handling, health checks, graceful shutdown
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8088;
const MUSIC_DIR = 'H:\\FreshWax-Backup';
const MAX_CONNECTIONS = 100;
const HEALTH_CHECK_INTERVAL = 60000; // 60 seconds (reduced frequency)
const RESTART_DELAY = 5000; // 5 seconds before restart attempt
const AUDIO_STREAM_BUFFER = 256 * 1024; // 256KB buffer for smooth audio
const AUDIO_TIMEOUT = 10 * 60 * 1000; // 10 minutes for audio streams

// Stats tracking
let stats = {
  startTime: Date.now(),
  requestsServed: 0,
  errors: 0,
  activeConnections: 0,
  lastHealthCheck: null,
  driveAvailable: true
};

// Cache for file list (rebuild every 10 minutes in background)
let fileCache = null;
let fileCacheTime = 0;
let isCacheRebuilding = false;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Logging with timestamps
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    console.log(logLine, data);
  } else {
    console.log(logLine);
  }
}

// Check if music directory is accessible (async to avoid blocking)
async function checkDriveAvailable() {
  return new Promise((resolve) => {
    fs.access(MUSIC_DIR, fs.constants.R_OK, (err) => {
      if (err) {
        if (stats.driveAvailable) {
          log('ERROR', 'Music drive is NOT available', err.message);
        }
        stats.driveAvailable = false;
        resolve(false);
      } else {
        if (!stats.driveAvailable) {
          log('INFO', 'Music drive is now available');
        }
        stats.driveAvailable = true;
        resolve(true);
      }
    });
  });
}

// Sync version only for startup
function checkDriveAvailableSync() {
  try {
    fs.accessSync(MUSIC_DIR, fs.constants.R_OK);
    stats.driveAvailable = true;
    return true;
  } catch (err) {
    stats.driveAvailable = false;
    return false;
  }
}

// Get base name without extension
function getBaseName(filename) {
  return filename.replace(/\.(mp3|webp|jpg|info\.json)$/i, '');
}

// Get cached file list (never blocks - triggers async rebuild if stale)
function getFileList() {
  const now = Date.now();

  // If cache is stale and not already rebuilding, trigger background rebuild
  if (fileCache && (now - fileCacheTime) >= CACHE_TTL && !isCacheRebuilding) {
    rebuildFileCacheAsync(); // Non-blocking
  }

  return fileCache || [];
}

// Sync version for startup only
function buildFileListSync() {
  if (!stats.driveAvailable) {
    return fileCache || [];
  }

  try {
    const allFiles = fs.readdirSync(MUSIC_DIR);
    const mp3Files = allFiles.filter(f => f.endsWith('.mp3'));
    const webpFiles = new Set(allFiles.filter(f => f.endsWith('.webp')).map(getBaseName));
    const jpgFiles = new Set(allFiles.filter(f => f.endsWith('.jpg')).map(getBaseName));

    const files = mp3Files.map(f => {
      const baseName = getBaseName(f);
      const displayName = baseName.replace(/\s*\[[^\]]+\]$/, '');

      let thumbnail = null;
      if (webpFiles.has(baseName)) {
        thumbnail = `/thumb/${encodeURIComponent(baseName + '.webp')}`;
      } else if (jpgFiles.has(baseName)) {
        thumbnail = `/thumb/${encodeURIComponent(baseName + '.jpg')}`;
      }

      return {
        name: displayName,
        file: f,
        url: `/music/${encodeURIComponent(f)}`,
        thumbnail,
        duration: null,
        uploader: null
      };
    });

    fileCache = files;
    fileCacheTime = Date.now();
    log('INFO', `File cache built: ${files.length} MP3 files`);
    return files;
  } catch (err) {
    log('ERROR', 'Failed to build file list', err.message);
    stats.errors++;
    return [];
  }
}

// Async background rebuild (never blocks audio streaming)
function rebuildFileCacheAsync() {
  if (isCacheRebuilding || !stats.driveAvailable) return;

  isCacheRebuilding = true;
  log('INFO', 'Starting background cache rebuild...');

  fs.readdir(MUSIC_DIR, (err, allFiles) => {
    if (err) {
      log('ERROR', 'Background cache rebuild failed', err.message);
      isCacheRebuilding = false;
      return;
    }

    // Process in next tick to avoid blocking
    setImmediate(() => {
      try {
        const mp3Files = allFiles.filter(f => f.endsWith('.mp3'));
        const webpFiles = new Set(allFiles.filter(f => f.endsWith('.webp')).map(getBaseName));
        const jpgFiles = new Set(allFiles.filter(f => f.endsWith('.jpg')).map(getBaseName));

        const files = mp3Files.map(f => {
          const baseName = getBaseName(f);
          const displayName = baseName.replace(/\s*\[[^\]]+\]$/, '');

          let thumbnail = null;
          if (webpFiles.has(baseName)) {
            thumbnail = `/thumb/${encodeURIComponent(baseName + '.webp')}`;
          } else if (jpgFiles.has(baseName)) {
            thumbnail = `/thumb/${encodeURIComponent(baseName + '.jpg')}`;
          }

          return {
            name: displayName,
            file: f,
            url: `/music/${encodeURIComponent(f)}`,
            thumbnail,
            duration: null,
            uploader: null
          };
        });

        fileCache = files;
        fileCacheTime = Date.now();
        isCacheRebuilding = false;
        log('INFO', `Background cache rebuilt: ${files.length} MP3 files`);
      } catch (e) {
        log('ERROR', 'Background cache processing failed', e.message);
        isCacheRebuilding = false;
      }
    });
  });
}

// Safe stream with error handling and optimized buffer for audio
function safeStreamFile(filePath, res, options = {}, isAudio = false) {
  // Use larger buffer for audio to prevent stuttering
  const streamOptions = {
    ...options,
    highWaterMark: isAudio ? AUDIO_STREAM_BUFFER : 64 * 1024
  };

  const stream = fs.createReadStream(filePath, streamOptions);

  stream.on('error', (err) => {
    log('ERROR', `Stream error for ${filePath}`, err.message);
    stats.errors++;
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Stream error');
  });

  stream.on('close', () => {
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
  });

  stream.pipe(res);
}

// Create the server
function createServer() {
  const server = http.createServer((req, res) => {
    stats.requestsServed++;
    stats.activeConnections++;

    // Connection limiting
    if (stats.activeConnections > MAX_CONNECTIONS) {
      stats.activeConnections--;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Server busy, try again');
      return;
    }

    // Track connection close
    res.on('close', () => {
      stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    });

    // Set timeout - longer for audio streams
    const isAudioRequest = req.url && req.url.startsWith('/music/');
    const timeout = isAudioRequest ? AUDIO_TIMEOUT : 60000;
    req.setTimeout(timeout, () => {
      if (!isAudioRequest) { // Don't log timeout for audio (they're expected to be long)
        log('WARN', 'Request timeout', req.url);
      }
      res.end();
    });

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

    try {
      const parsedUrl = url.parse(req.url, true);
      let filePath = decodeURIComponent(parsedUrl.pathname);

      // Health check endpoint
      if (filePath === '/health') {
        const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
        const health = {
          status: stats.driveAvailable ? 'healthy' : 'degraded',
          uptime: uptime,
          uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
          requestsServed: stats.requestsServed,
          errors: stats.errors,
          activeConnections: stats.activeConnections,
          driveAvailable: stats.driveAvailable,
          fileCount: fileCache ? fileCache.length : 0,
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
        return;
      }

      // /list - return JSON list of all MP3s (uses cached list, never blocks)
      if (filePath === '/list') {
        if (!stats.driveAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Music drive not available', cached: !!fileCache }));
          return;
        }
        const files = getFileList();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: files.length, files }));
        return;
      }

      // /random - return a single random MP3 (uses cached list, never blocks)
      if (filePath === '/random') {
        if (!stats.driveAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Music drive not available' }));
          return;
        }
        const files = getFileList();
        if (files.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No files available' }));
          return;
        }
        // Prefer files with thumbnails
        const filesWithThumbs = files.filter(f => f.thumbnail);
        const filesToPickFrom = filesWithThumbs.length > 0 ? filesWithThumbs : files;
        const randomIndex = Math.floor(Math.random() * filesToPickFrom.length);
        const selected = filesToPickFrom[randomIndex];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, track: selected, totalCount: files.length }));
        return;
      }

      // /thumb/filename - serve thumbnail images
      if (filePath.startsWith('/thumb/')) {
        const fileName = decodeURIComponent(filePath.replace('/thumb/', ''));
        const fullPath = path.join(MUSIC_DIR, fileName);

        if (!fullPath.startsWith(MUSIC_DIR)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        fs.stat(fullPath, (err, fstats) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Thumbnail not found');
            stats.activeConnections--;
            return;
          }

          const ext = path.extname(fileName).toLowerCase();
          const contentType = ext === '.webp' ? 'image/webp' : 'image/jpeg';

          res.writeHead(200, {
            'Content-Length': fstats.size,
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400'
          });
          safeStreamFile(fullPath, res);
        });
        return;
      }

      // /music/filename.mp3 - serve audio files
      if (filePath.startsWith('/music/')) {
        const fileName = decodeURIComponent(filePath.replace('/music/', ''));
        const fullPath = path.join(MUSIC_DIR, fileName);

        if (!fullPath.startsWith(MUSIC_DIR)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        fs.stat(fullPath, (err, fstats) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            stats.activeConnections--;
            return;
          }

          const range = req.headers.range;
          const fileSize = fstats.size;

          if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;

            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize,
              'Content-Type': 'audio/mpeg',
              'Cache-Control': 'public, max-age=3600'
            });
            safeStreamFile(fullPath, res, { start, end }, true); // true = audio
          } else {
            res.writeHead(200, {
              'Content-Length': fileSize,
              'Content-Type': 'audio/mpeg',
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'public, max-age=3600'
            });
            safeStreamFile(fullPath, res, {}, true); // true = audio
          }
        });
        return;
      }

      // Root - status page
      if (filePath === '/') {
        const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
        const count = fileCache ? fileCache.length : 0;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head><title>FreshWax Playlist Server</title></head>
            <body style="font-family: system-ui; background: #111; color: #fff; padding: 2rem;">
              <h1>🎵 FreshWax Playlist Server</h1>
              <p><strong>${count}</strong> MP3 files available</p>
              <p>Drive: <span style="color: ${stats.driveAvailable ? '#0f0' : '#f00'}">${stats.driveAvailable ? '✓ Online' : '✗ Offline'}</span></p>
              <p>Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s</p>
              <p>Requests: ${stats.requestsServed} | Errors: ${stats.errors} | Active: ${stats.activeConnections}</p>
              <p>Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
              <p><a href="/list" style="color: #0af;">View file list (JSON)</a> | <a href="/random" style="color: #0af;">Random track</a> | <a href="/health" style="color: #0af;">Health check</a></p>
            </body>
          </html>
        `);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');

    } catch (err) {
      log('ERROR', 'Request handler error', err.message);
      stats.errors++;
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Internal server error');
    }
  });

  // Server error handling
  server.on('error', (err) => {
    log('ERROR', 'Server error', err.message);
    stats.errors++;
    if (err.code === 'EADDRINUSE') {
      log('ERROR', `Port ${PORT} is already in use`);
      process.exit(1);
    }
  });

  // Connection error handling
  server.on('clientError', (err, socket) => {
    log('WARN', 'Client error', err.message);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  return server;
}

// Periodic health check (async to avoid blocking audio streams)
function startHealthCheck() {
  setInterval(async () => {
    await checkDriveAvailable();
    stats.lastHealthCheck = new Date().toISOString();

    // Memory warning
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (memMB > 500) {
      log('WARN', `High memory usage: ${Math.round(memMB)} MB`);
    }
  }, HEALTH_CHECK_INTERVAL);
}

// Graceful shutdown
function setupGracefulShutdown(server) {
  const shutdown = (signal) => {
    log('INFO', `Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      log('INFO', 'Server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      log('WARN', 'Forcing shutdown');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Global error handlers (prevents crashes)
process.on('uncaughtException', (err) => {
  log('ERROR', 'Uncaught exception', err.stack || err.message);
  stats.errors++;
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  log('ERROR', 'Unhandled rejection', reason);
  stats.errors++;
});

// Start the server
function start() {
  // Initial drive check (sync at startup is fine)
  checkDriveAvailableSync();

  // Pre-build file cache (sync at startup is fine)
  if (stats.driveAvailable) {
    buildFileListSync();
  }

  const server = createServer();

  server.listen(PORT, () => {
    log('INFO', `Playlist server running at http://localhost:${PORT}`);
    log('INFO', `Serving files from: ${MUSIC_DIR}`);
    log('INFO', `Drive available: ${stats.driveAvailable}`);
    log('INFO', `Files cached: ${fileCache ? fileCache.length : 0}`);
    console.log(`
  Endpoints:
    /        - Status page
    /list    - JSON list of all MP3s
    /random  - Single random MP3 (for auto-play)
    /music/* - Stream MP3 files
    /thumb/* - Serve thumbnails
    /health  - Health check (JSON)

  Press Ctrl+C to stop
    `);
  });

  setupGracefulShutdown(server);
  startHealthCheck();
}

start();
