// Audio Relay Server for FreshWax
// Proxies external radio streams with CORS headers
// Runs on port 8765, served via cloudflared tunnel as relay.freshwax.co.uk

const http = require('http');

const STATIONS = {
  'underground-lair': {
    name: 'The Underground Lair',
    url: 'http://95.217.34.48:8340/stream3'
  }
  // Add more stations here as needed
};

const server = http.createServer((req, res) => {
  // Extract station ID from path (e.g., /underground-lair)
  const stationId = req.url.replace('/', '').split('?')[0];

  console.log(`[Relay] Request for station: ${stationId}`);

  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const station = STATIONS[stationId];
  if (!station) {
    console.log(`[Relay] Unknown station: ${stationId}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown station', stationId }));
    return;
  }

  console.log(`[Relay] Proxying ${station.name} from ${station.url}`);

  // Proxy the stream
  const proxyReq = http.get(station.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Icy-MetaData': '0'
    }
  }, (proxyRes) => {
    console.log(`[Relay] Connected to ${station.name}, status: ${proxyRes.statusCode}`);

    // Pass through content type
    const contentType = proxyRes.headers['content-type'] || 'audio/mpeg';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Relay-Station': station.name
    });

    proxyRes.pipe(res);

    proxyRes.on('end', () => {
      console.log(`[Relay] Stream ended for ${station.name}`);
    });

    proxyRes.on('error', (err) => {
      console.error(`[Relay] Stream error for ${station.name}:`, err.message);
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Relay] Connection error for ${station.name}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stream connection failed', message: err.message }));
    }
  });

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[Relay] Client disconnected from ${station.name}`);
    proxyReq.destroy();
  });
});

const PORT = 8765;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Relay] Audio relay server running on http://127.0.0.1:${PORT}`);
  console.log('[Relay] Available stations:');
  Object.entries(STATIONS).forEach(([id, station]) => {
    console.log(`  - /${id} -> ${station.name}`);
  });
});
