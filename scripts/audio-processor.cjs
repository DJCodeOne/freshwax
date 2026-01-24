// FreshWax Audio Processor Server
// Converts audio files using native FFmpeg for broadcast-quality output
// - WAV upload → creates 320kbps CBR MP3 (DJ quality)
// - MP3 upload → creates 16-bit 44.1kHz WAV

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// Load environment from .env file
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  });
}

const PORT = process.env.AUDIO_PROCESSOR_PORT || 8089;
const TEMP_DIR = path.join(__dirname, '..', 'temp', 'audio-processing');

// R2 Configuration
const R2_CONFIG = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucketName: 'freshwax-releases',
  publicDomain: process.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk'
};

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Generate AWS Signature v4 for R2 requests
 */
function signR2Request(method, path, headers, payload = '') {
  const service = 's3';
  const region = 'auto';
  const host = `${R2_CONFIG.accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // Add required headers
  headers['host'] = host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = crypto.createHash('sha256').update(payload).digest('hex');

  // Create canonical request
  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map(k => `${k.toLowerCase()}:${headers[k]}\n`).join('');
  const signedHeaders = sortedHeaders.map(k => k.toLowerCase()).join(';');

  const canonicalRequest = [
    method,
    path,
    '', // query string
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256']
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  // Calculate signature
  const getSignatureKey = (key, dateStamp, region, service) => {
    const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    return crypto.createHmac('sha256', kService).update('aws4_request').digest();
  };

  const signingKey = getSignatureKey(R2_CONFIG.secretAccessKey, dateStamp, region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  // Create authorization header
  headers['Authorization'] = `${algorithm} Credential=${R2_CONFIG.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

/**
 * Download file from R2
 */
function downloadFromR2(key) {
  return new Promise((resolve, reject) => {
    const path = `/${R2_CONFIG.bucketName}/${key}`;
    const headers = signR2Request('GET', path, {});

    const options = {
      hostname: `${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
      port: 443,
      path: path,
      method: 'GET',
      headers: headers
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`R2 download failed: ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Upload file to R2
 */
function uploadToR2(key, data, contentType) {
  return new Promise((resolve, reject) => {
    const path = `/${R2_CONFIG.bucketName}/${key}`;
    const headers = signR2Request('PUT', path, {
      'Content-Type': contentType,
      'Content-Length': data.length.toString(),
      'Cache-Control': 'public, max-age=31536000'
    }, data);

    const options = {
      hostname: `${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
      port: 443,
      path: path,
      method: 'PUT',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(`${R2_CONFIG.publicDomain}/${key}`);
        } else {
          reject(new Error(`R2 upload failed: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Get audio format from filename
 */
function getAudioFormat(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'wav') return 'wav';
  if (ext === 'mp3') return 'mp3';
  if (ext === 'flac') return 'flac';
  if (ext === 'aiff' || ext === 'aif') return 'aiff';
  return 'unknown';
}

/**
 * Convert audio using FFmpeg
 * WAV/FLAC/AIFF → 320kbps CBR MP3 (DJ quality)
 * MP3 → 16-bit 44.1kHz WAV
 */
function convertAudio(inputPath, outputPath, outputFormat) {
  return new Promise((resolve, reject) => {
    let args;

    if (outputFormat === 'mp3') {
      // Convert to 320kbps CBR MP3 - DJ/broadcast quality settings
      // Note: Do NOT use -q:a with -b:a as -q:a forces VBR mode
      args = [
        '-i', inputPath,
        '-codec:a', 'libmp3lame',
        '-b:a', '320k',           // Constant bitrate 320kbps (CBR)
        '-joint_stereo', '0',     // Full stereo (better quality at 320k)
        '-cutoff', '20500',       // Full frequency range (20.5kHz) for 320k
        '-reservoir', '0',        // Disable bit reservoir for strict CBR
        '-write_xing', '1',       // Write Xing/LAME header for compatibility
        '-id3v2_version', '3',    // ID3v2.3 for DJ software compatibility
        '-y',                     // Overwrite output
        outputPath
      ];
    } else if (outputFormat === 'wav') {
      // Convert to 16-bit 44.1kHz WAV - CD quality
      args = [
        '-i', inputPath,
        '-codec:a', 'pcm_s16le',  // 16-bit signed little-endian PCM
        '-ar', '44100',           // 44.1kHz sample rate
        '-ac', '2',               // Stereo
        '-y',                     // Overwrite output
        outputPath
      ];
    } else {
      reject(new Error(`Unsupported output format: ${outputFormat}`));
      return;
    }

    console.log(`[FFmpeg] Converting to ${outputFormat}: ${path.basename(inputPath)}`);
    console.log(`[FFmpeg] Command: ffmpeg ${args.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Verify output file exists and has content
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          if (stats.size > 0) {
            console.log(`[FFmpeg] Success: ${path.basename(outputPath)} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            resolve(outputPath);
          } else {
            reject(new Error('Output file is empty'));
          }
        } else {
          reject(new Error('Output file not created'));
        }
      } else {
        console.error(`[FFmpeg] Error (code ${code}):`, stderr);
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/**
 * Create 90-second preview clip with fade out
 * Starts 1 minute into the track to prevent full track copying
 */
function createPreview(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Preview: start at 60s (1 min in), 90s duration, 192kbps, fade out last 5s
    const args = [
      '-i', inputPath,
      '-ss', '60',              // Start at 1 minute into track
      '-t', '90',               // 90 seconds duration
      '-codec:a', 'libmp3lame',
      '-b:a', '192k',           // 192kbps for previews
      '-ar', '44100',
      '-af', 'afade=t=out:st=85:d=5',  // Fade out last 5 seconds (starts at 85s)
      '-y',
      outputPath
    ];

    console.log(`[FFmpeg] Creating preview: ${path.basename(inputPath)}`);

    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        console.log(`[FFmpeg] Preview created: ${path.basename(outputPath)}`);
        resolve(outputPath);
      } else {
        // Preview creation might fail for short tracks, not critical
        console.warn(`[FFmpeg] Preview creation failed (non-critical): ${stderr.slice(-200)}`);
        resolve(null);
      }
    });

    ffmpeg.on('error', () => resolve(null));
  });
}

/**
 * Process a single audio track
 * SMART PROCESSING:
 * - WAV/FLAC/AIFF source → Create MP3 only, keep original WAV URL (no duplication)
 * - MP3 source → Create WAV from MP3 (lossy but needed for WAV download option)
 */
async function processTrack(sourceKey, releaseFolder, trackNumber, trackTitle, originalWavUrl) {
  const sourceFormat = getAudioFormat(sourceKey);
  console.log(`[Processor] Processing track ${trackNumber}: ${trackTitle}`);
  console.log(`[Processor] Source: ${sourceKey} (${sourceFormat})`);

  // If there's already an original WAV URL and source is MP3, skip - we have both formats
  if (sourceFormat === 'mp3' && originalWavUrl) {
    console.log(`[Processor] Source is MP3 but original WAV exists - skipping`);
    const sourceUrl = `${R2_CONFIG.publicDomain}/${sourceKey}`;
    return {
      trackNumber,
      title: trackTitle,
      mp3Url: sourceUrl,
      wavUrl: originalWavUrl,
      previewUrl: sourceUrl,
      skipped: true,
      reason: 'Already has both MP3 and WAV'
    };
  }

  // Validate supported formats
  if (!['wav', 'flac', 'aiff', 'mp3'].includes(sourceFormat)) {
    throw new Error(`Unsupported audio format: ${sourceFormat}`);
  }

  const jobId = crypto.randomBytes(4).toString('hex');
  const tempDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Download source file
    console.log(`[Processor] Downloading from R2...`);
    const sourceData = await downloadFromR2(sourceKey);
    console.log(`[Processor] Downloaded: ${(sourceData.length / 1024 / 1024).toFixed(2)} MB`);

    const sourceFilename = path.basename(sourceKey);
    const sourcePath = path.join(tempDir, sourceFilename);
    fs.writeFileSync(sourcePath, sourceData);

    // Generate safe filename
    const safeTitle = trackTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    const paddedNum = trackNumber.toString().padStart(2, '0');

    let mp3Url, wavUrl, mp3Size, wavSize;

    if (sourceFormat === 'mp3') {
      // MP3 source: keep MP3 as-is, create WAV for download option
      console.log(`[Processor] Source is MP3 - creating WAV for download option`);

      mp3Url = `${R2_CONFIG.publicDomain}/${sourceKey}`;
      mp3Size = sourceData.length;

      // Convert MP3 to WAV (16-bit 44.1kHz)
      const wavPath = path.join(tempDir, `${paddedNum}-${safeTitle}.wav`);
      await convertAudio(sourcePath, wavPath, 'wav');
      const wavData = fs.readFileSync(wavPath);

      // Upload WAV to R2
      console.log(`[Processor] Uploading WAV to R2...`);
      const wavKey = `${releaseFolder}/tracks/${paddedNum}-${safeTitle}.wav`;
      wavUrl = await uploadToR2(wavKey, wavData, 'audio/wav');
      wavSize = wavData.length;

      console.log(`[Processor] Track ${trackNumber} complete:`);
      console.log(`  MP3: ${mp3Url} [ORIGINAL]`);
      console.log(`  WAV: ${wavUrl} (${(wavSize / 1024 / 1024).toFixed(2)} MB) [CREATED FROM MP3]`);

    } else {
      // WAV/FLAC/AIFF source: create MP3, keep original as WAV
      console.log(`[Processor] Source is ${sourceFormat.toUpperCase()} - creating MP3 only`);

      // Convert to 320kbps MP3
      const mp3Path = path.join(tempDir, `${paddedNum}-${safeTitle}.mp3`);
      await convertAudio(sourcePath, mp3Path, 'mp3');
      const mp3Data = fs.readFileSync(mp3Path);

      // Upload MP3 to R2
      console.log(`[Processor] Uploading MP3 to R2...`);
      const mp3Key = `${releaseFolder}/tracks/${paddedNum}-${safeTitle}.mp3`;
      mp3Url = await uploadToR2(mp3Key, mp3Data, 'audio/mpeg');
      mp3Size = mp3Data.length;

      // Keep original WAV/FLAC/AIFF URL - no duplication!
      wavUrl = originalWavUrl || `${R2_CONFIG.publicDomain}/${sourceKey}`;

      console.log(`[Processor] Track ${trackNumber} complete:`);
      console.log(`  MP3: ${mp3Url} (${(mp3Size / 1024 / 1024).toFixed(2)} MB) [NEW]`);
      console.log(`  WAV: ${wavUrl} [ORIGINAL - no duplication]`);
    }

    return {
      trackNumber,
      title: trackTitle,
      mp3Url,
      wavUrl,
      previewUrl: mp3Url,
      mp3Size,
      wavSize
    };

  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[Cleanup] Failed to remove temp dir: ${e.message}`);
    }
  }
}

/**
 * Handle HTTP requests
 */
async function handleRequest(req, res) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'audio-processor',
      ffmpeg: true,
      r2Configured: !!(R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey)
    }));
    return;
  }

  // Process single track
  if (url.pathname === '/process-track' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { sourceKey, releaseFolder, trackNumber, trackTitle, originalWavUrl } = data;

        if (!sourceKey || !releaseFolder || !trackNumber || !trackTitle) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: 'Missing required fields: sourceKey, releaseFolder, trackNumber, trackTitle' }));
          return;
        }

        console.log(`\n[API] Process track request:`);
        console.log(`  Source: ${sourceKey}`);
        console.log(`  Release: ${releaseFolder}`);
        console.log(`  Track: ${trackNumber} - ${trackTitle}`);
        if (originalWavUrl) console.log(`  Original WAV: ${originalWavUrl}`);

        const result = await processTrack(sourceKey, releaseFolder, trackNumber, trackTitle, originalWavUrl);

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, ...result }));

      } catch (error) {
        console.error('[API] Process track error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // Process full release (all tracks)
  if (url.pathname === '/process-release' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { tracks, releaseFolder } = data;

        if (!tracks || !Array.isArray(tracks) || !releaseFolder) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: 'Missing required fields: tracks (array), releaseFolder' }));
          return;
        }

        console.log(`\n[API] Process release request: ${releaseFolder}`);
        console.log(`  Tracks: ${tracks.length}`);

        const results = [];
        for (const track of tracks) {
          try {
            const result = await processTrack(
              track.sourceKey,
              releaseFolder,
              track.trackNumber,
              track.title
            );
            results.push(result);
          } catch (error) {
            console.error(`[API] Track ${track.trackNumber} failed:`, error);
            results.push({
              trackNumber: track.trackNumber,
              title: track.title,
              error: error.message
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, tracks: results }));

      } catch (error) {
        console.error('[API] Process release error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify({
    service: 'FreshWax Audio Processor',
    version: '1.0.0',
    endpoints: {
      'GET /health': 'Health check',
      'POST /process-track': 'Process single track { sourceKey, releaseFolder, trackNumber, trackTitle }',
      'POST /process-release': 'Process all tracks { tracks: [{sourceKey, trackNumber, title}], releaseFolder }'
    }
  }));
}

// Create server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     FreshWax Audio Processor                           ║
║     Broadcast-quality audio conversion using FFmpeg    ║
╠════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                            ║
║  FFmpeg: Native                                        ║
║  Output: 320kbps CBR MP3 / 16-bit 44.1kHz WAV        ║
╠════════════════════════════════════════════════════════╣
║  Endpoints:                                            ║
║  • GET  /health         - Health check                 ║
║  • POST /process-track  - Process single track         ║
║  • POST /process-release - Process full release        ║
╠════════════════════════════════════════════════════════╣
║  Press Ctrl+C to stop                                  ║
╚════════════════════════════════════════════════════════╝
`);
  console.log(`[Startup] R2 configured: ${!!(R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey)}`);
  console.log(`[Startup] Temp directory: ${TEMP_DIR}`);
});

// Handle errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ERROR] Port ${PORT} is already in use`);
  } else {
    console.error('[ERROR] Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, closing server...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('\n[Shutdown] SIGINT received, closing server...');
  server.close(() => process.exit(0));
});
