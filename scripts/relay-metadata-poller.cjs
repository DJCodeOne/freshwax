// scripts/relay-metadata-poller.cjs
// Polls relay stream for ICY metadata and updates slot title via Pusher
// Run with: node scripts/relay-metadata-poller.cjs

const http = require('http');
const https = require('https');
const Pusher = require('pusher');

// Configuration
const RELAY_URL = 'http://95.217.34.48:8340/stream3';
const POLL_INTERVAL = 30000; // 30 seconds
const STATION_NAME = 'The Underground Lair';

// Pusher config (same as in the app)
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '1aborui',
  key: process.env.PUSHER_KEY || '64109250a74381d2dc66',
  secret: process.env.PUSHER_SECRET,
  cluster: 'eu',
  useTLS: true
});

// API config
const API_BASE = 'https://freshwax.co.uk';
const ADMIN_KEY = process.env.ADMIN_KEY;

let currentTitle = null;
let currentSlotId = null;

// Parse ICY metadata from stream
function parseIcyMetadata(buffer) {
  const str = buffer.toString('utf8');
  const match = str.match(/StreamTitle='([^']*?)'/i);
  return match ? match[1] : null;
}

// Get current live slot ID
async function getCurrentSlotId() {
  return new Promise((resolve, reject) => {
    https.get(`${API_BASE}/api/livestream/status`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success && json.primaryStream?.isRelay) {
            resolve(json.primaryStream.slotId || json.primaryStream.id);
          } else {
            resolve(null);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Update slot title via API
async function updateSlotTitle(slotId, title) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ slotId, title, adminKey: ADMIN_KEY });

    const req = https.request(`${API_BASE}/api/livestream/update-slot-title`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API error: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Send Pusher event for title update
async function sendPusherUpdate(slotId, title) {
  try {
    await pusher.trigger('live-status', 'title-update', {
      slotId,
      title,
      timestamp: new Date().toISOString()
    });
    console.log(`[Pusher] Sent title update: ${title}`);
  } catch (e) {
    console.error('[Pusher] Error:', e.message);
  }
}

// Poll stream for metadata
function pollMetadata() {
  const url = new URL(RELAY_URL);

  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers: {
      'Icy-MetaData': '1',
      'User-Agent': 'FreshWax-MetadataPoller/1.0'
    }
  }, (res) => {
    const metaInt = parseInt(res.headers['icy-metaint'], 10);

    if (!metaInt) {
      console.log('[Poll] No icy-metaint header, stream may not support metadata');
      req.destroy();
      return;
    }

    let bytesRead = 0;
    let metadataBuffer = Buffer.alloc(0);
    let expectingMetadata = false;
    let metadataLength = 0;

    res.on('data', (chunk) => {
      // Process chunk to find metadata
      let offset = 0;

      while (offset < chunk.length) {
        if (!expectingMetadata) {
          const remaining = metaInt - (bytesRead % metaInt);
          const audioBytes = Math.min(remaining, chunk.length - offset);
          bytesRead += audioBytes;
          offset += audioBytes;

          if (bytesRead % metaInt === 0 && offset < chunk.length) {
            // Next byte is metadata length
            metadataLength = chunk[offset] * 16;
            offset++;
            expectingMetadata = true;
            metadataBuffer = Buffer.alloc(0);
          }
        } else {
          const needed = metadataLength - metadataBuffer.length;
          const available = Math.min(needed, chunk.length - offset);
          metadataBuffer = Buffer.concat([metadataBuffer, chunk.slice(offset, offset + available)]);
          offset += available;

          if (metadataBuffer.length === metadataLength) {
            // Got full metadata
            if (metadataLength > 0) {
              const title = parseIcyMetadata(metadataBuffer);
              if (title) {
                handleTitleChange(title);
              }
            }
            expectingMetadata = false;
            // Got metadata, close connection
            req.destroy();
            return;
          }
        }
      }
    });

    // Timeout after 5 seconds if no metadata found
    setTimeout(() => req.destroy(), 5000);
  });

  req.on('error', (e) => {
    if (e.code !== 'ECONNRESET') {
      console.error('[Poll] Error:', e.message);
    }
  });

  req.end();
}

// Handle title change
async function handleTitleChange(rawTitle) {
  // Use raw title as-is (don't append station name)
  const formattedTitle = rawTitle || 'Live Stream';

  if (formattedTitle === currentTitle) {
    console.log(`[Poll] No change: ${formattedTitle}`);
    return;
  }

  console.log(`[Poll] Title changed: ${currentTitle} -> ${formattedTitle}`);
  currentTitle = formattedTitle;

  // Get current slot ID if not cached
  if (!currentSlotId) {
    currentSlotId = await getCurrentSlotId();
  }

  if (!currentSlotId) {
    console.log('[Poll] No active relay slot found');
    return;
  }

  // Update Firestore via API
  if (ADMIN_KEY) {
    try {
      await updateSlotTitle(currentSlotId, formattedTitle);
      console.log(`[API] Updated slot ${currentSlotId}`);
    } catch (e) {
      console.error('[API] Error:', e.message);
    }
  }

  // Send Pusher update
  if (process.env.PUSHER_SECRET) {
    await sendPusherUpdate(currentSlotId, formattedTitle);
  }
}

// Main loop
async function main() {
  console.log('=== Relay Metadata Poller ===');
  console.log(`Polling: ${RELAY_URL}`);
  console.log(`Interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`Admin key: ${ADMIN_KEY ? 'Set' : 'NOT SET'}`);
  console.log(`Pusher secret: ${process.env.PUSHER_SECRET ? 'Set' : 'NOT SET'}`);
  console.log('');

  // Initial poll
  pollMetadata();

  // Schedule regular polls
  setInterval(pollMetadata, POLL_INTERVAL);
}

main();
