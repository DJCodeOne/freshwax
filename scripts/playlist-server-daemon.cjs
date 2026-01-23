// FreshWax Playlist Server Daemon
// Auto-restarts the server on crash with exponential backoff
// Run this instead of playlist-server.cjs for maximum reliability

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_SCRIPT = path.join(__dirname, 'playlist-server.cjs');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const RESTART_LOG = path.join(LOG_DIR, 'playlist-server-restarts.log');

// Restart settings
const MIN_RESTART_DELAY = 1000;      // 1 second minimum
const MAX_RESTART_DELAY = 60000;     // 1 minute maximum
const RESTART_RESET_TIME = 300000;   // Reset delay after 5 minutes of uptime

let restartDelay = MIN_RESTART_DELAY;
let restartCount = 0;
let lastStartTime = null;
let serverProcess = null;
let isShuttingDown = false;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}`;
  console.log(logLine);

  try {
    fs.appendFileSync(RESTART_LOG, logLine + '\n');
  } catch (e) {
    // Ignore log write errors
  }
}

function startServer() {
  if (isShuttingDown) return;

  lastStartTime = Date.now();
  restartCount++;

  log(`Starting playlist server (attempt #${restartCount})...`);

  serverProcess = spawn('node', [SERVER_SCRIPT], {
    stdio: 'inherit',
    cwd: __dirname
  });

  serverProcess.on('error', (err) => {
    log(`Failed to start server: ${err.message}`);
    scheduleRestart();
  });

  serverProcess.on('exit', (code, signal) => {
    if (isShuttingDown) {
      log('Server stopped by user');
      process.exit(0);
    }

    const uptime = Date.now() - lastStartTime;
    const uptimeStr = `${Math.floor(uptime / 1000)}s`;

    if (code === 0) {
      log(`Server exited cleanly after ${uptimeStr}`);
    } else {
      log(`Server crashed after ${uptimeStr} (code: ${code}, signal: ${signal})`);
    }

    // Reset delay if server ran for a while
    if (uptime > RESTART_RESET_TIME) {
      restartDelay = MIN_RESTART_DELAY;
      log('Server was stable, resetting restart delay');
    }

    scheduleRestart();
  });
}

function scheduleRestart() {
  if (isShuttingDown) return;

  log(`Restarting in ${restartDelay / 1000} seconds...`);

  setTimeout(() => {
    // Exponential backoff
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
    startServer();
  }, restartDelay);
}

function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  isShuttingDown = true;

  if (serverProcess) {
    serverProcess.kill('SIGTERM');

    // Force kill after 10 seconds
    setTimeout(() => {
      if (serverProcess) {
        log('Force killing server');
        serverProcess.kill('SIGKILL');
      }
      process.exit(0);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
console.log(`
╔═══════════════════════════════════════════════════════╗
║     FreshWax Playlist Server Daemon                   ║
║     Auto-restart enabled with exponential backoff     ║
╠═══════════════════════════════════════════════════════╣
║  • Min restart delay: ${MIN_RESTART_DELAY / 1000}s                            ║
║  • Max restart delay: ${MAX_RESTART_DELAY / 1000}s                           ║
║  • Delay resets after ${RESTART_RESET_TIME / 60000} minutes of uptime          ║
╠═══════════════════════════════════════════════════════╣
║  Press Ctrl+C to stop                                 ║
╚═══════════════════════════════════════════════════════╝
`);

log('Daemon started');
startServer();
