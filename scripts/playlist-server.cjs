// Robust HTTP server to serve playlist MP3s, thumbnails, and metadata
// Features: Auto-recovery, error handling, health checks, graceful shutdown
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8088;
const MUSIC_DIR = 'H:\\FreshWax-Backup';
const MAX_CONNECTIONS = 100;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const RESTART_DELAY = 5000; // 5 seconds before restart attempt

// Stats tracking
let stats = {
  startTime: Date.now(),
  requestsServed: 0,
  errors: 0,
  activeConnections: 0,
  lastHealthCheck: null,
  driveAvailable: true
};

// Cache for file list (rebuild every 5 minutes)
let fileCache = null;
let fileCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

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

// Check if music directory is accessible
function checkDriveAvailable() {
  try {
    fs.accessSync(MUSIC_DIR, fs.constants.R_OK);
    if (!stats.driveAvailable) {
      log('INFO', 'Music drive is now available');
    }
    stats.driveAvailable = true;
    return true;
  } catch (err) {
    if (stats.driveAvailable) {
      log('ERROR', 'Music drive is NOT available', err.message);
    }
    stats.driveAvailable = false;
    return false;
  }
}

// Get base name without extension
function getBaseName(filename) {
  return filename.replace(/\.(mp3|webp|jpg|info\.json)$/i, '');
}

// Build file list with thumbnails and metadata (async-safe)
function buildFileList() {
  const now = Date.now();
  if (fileCache && (now - fileCacheTime) < CACHE_TTL) {
    return fileCache;
  }

  if (!checkDriveAvailable()) {
    // Return cached data if available, otherwise empty
    return fileCache || [];
  }

  try {
    const allFiles = fs.readdirSync(MUSIC_DIR);
    const mp3Files = allFiles.filter(f => f.endsWith('.mp3'));
    const webpFiles = new Set(allFiles.filter(f => f.endsWith('.webp')).map(getBaseName));
    const jpgFiles = new Set(allFiles.filter(f => f.endsWith('.jpg')).map(getBaseName));
    const jsonFiles = new Set(allFiles.filter(f => f.endsWith('.info.json')).map(f => f.replace('.info.json', '')));

    const files = mp3Files.map(f => {
      const baseName = getBaseName(f);
      const displayName = baseName.replace(/\s*\[[^\]]+\]$/, '');

      let thumbnail = null;
      if (webpFiles.has(baseName)) {
        thumbnail = `/thumb/${encodeURIComponent(baseName + '.webp')}`;
      } else if (jpgFiles.has(baseName)) {
        thumbnail = `/thumb/${encodeURIComponent(baseName + '.jpg')}`;
      }

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
    log('INFO', `File cache rebuilt: ${files.length} MP3 files`);
    return files;
  } catch (err) {
    log('ERROR', 'Failed to build file list', err.message);
    stats.errors++;
    return fileCache || [];
  }
}

// Safe stream with error handling
function safeStreamFile(filePath, res, options = {}) {
  const stream = fs.createReadStream(filePath, options);

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

    // Set timeout for stale connections
    req.setTimeout(60000, () => {
      log('WARN', 'Request timeout', req.url);
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

      // /list - return JSON list of all MP3s
      if (filePath === '/list') {
        if (!stats.driveAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Music drive not available', cached: !!fileCache }));
          return;
        }
        const files = buildFileList();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: files.length, files }));
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
              'Content-Type': 'audio/mpeg'
            });
            safeStreamFile(fullPath, res, { start, end });
          } else {
            res.writeHead(200, {
              'Content-Length': fileSize,
              'Content-Type': 'audio/mpeg',
              'Accept-Ranges': 'bytes'
            });
            safeStreamFile(fullPath, res);
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
              <p><a href="/list" style="color: #0af;">View file list (JSON)</a> | <a href="/health" style="color: #0af;">Health check</a></p>
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

// Periodic health check
function startHealthCheck() {
  setInterval(() => {
    checkDriveAvailable();
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
  // Initial drive check
  checkDriveAvailable();

  // Pre-build file cache
  if (stats.driveAvailable) {
    buildFileList();
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
