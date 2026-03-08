// Re-upload release files from a ZIP, preserving existing Firebase metadata
// Usage: node scripts/reupload-release.cjs <path-to-zip> [releaseId]
//
// This script:
// 1. Extracts artwork + audio files from the ZIP
// 2. Uploads them to the existing R2 releases folder
// 3. Updates the Firebase release document with correct track URLs
// 4. Preserves all original metadata (pricing, copyright, description, etc.)

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

// Read .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

const accountId = envVars.R2_ACCOUNT_ID;
const accessKeyId = envVars.R2_ACCESS_KEY_ID;
const secretAccessKey = envVars.R2_SECRET_ACCESS_KEY;
const bucketName = envVars.R2_BUCKET_NAME || 'freshwax-releases';
const publicDomain = 'https://cdn.freshwax.co.uk';

// Firebase service account for writes
const saEmail = envVars.FIREBASE_SA_CLIENT_EMAIL;
const saKeyRaw = envVars.FIREBASE_SA_PRIVATE_KEY;
const projectId = envVars.FIREBASE_PROJECT_ID || 'freshwax-store';

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Missing R2 credentials in .env');
  process.exit(1);
}

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

// --- Firebase JWT auth ---
const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  if (!saEmail || !saKeyRaw) {
    console.error('Missing FIREBASE_SA_CLIENT_EMAIL or FIREBASE_SA_PRIVATE_KEY in .env');
    process.exit(1);
  }
  const key = saKeyRaw.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: saEmail,
    sub: saEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform',
  })));
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = base64url(sign.sign(key));
  const jwt = `${sigInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error('Failed to get access token:', tokenData);
    process.exit(1);
  }
  return tokenData.access_token;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

async function updateFirestoreDoc(releaseId, updates) {
  const token = await getAccessToken();
  const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}`;

  // Build updateMask from the keys we're updating
  const updateMask = Object.keys(updates).map(k => `updateMask.fieldPaths=${k}`).join('&');

  const fields = {};
  for (const [k, v] of Object.entries(updates)) {
    fields[k] = toFirestoreValue(v);
  }

  const res = await fetch(`${docUrl}?${updateMask}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore update failed: ${res.status} ${text}`);
  }

  return await res.json();
}

// --- Main ---
async function main() {
  const zipPath = process.argv[2];
  const releaseId = process.argv[3] || 'elipse_draai_FW-1772922642977';

  if (!zipPath) {
    console.log('Usage: node scripts/reupload-release.cjs <path-to-zip> [releaseId]');
    console.log('');
    console.log('Default releaseId: elipse_draai_FW-1772922642977 (Elipse & Draai - Universal Language)');
    process.exit(0);
  }

  if (!fs.existsSync(zipPath)) {
    console.error(`ZIP file not found: ${zipPath}`);
    process.exit(1);
  }

  // Load existing release metadata
  const metadataPath = path.join(__dirname, `release-${releaseId}.json`);
  let existingRelease;
  if (fs.existsSync(metadataPath)) {
    existingRelease = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    console.log(`Loaded existing metadata: ${existingRelease.artistName} - ${existingRelease.releaseName}`);
  } else {
    console.log(`No cached metadata found at ${metadataPath}`);
    console.log(`Run first: node scripts/get-release-data.cjs ${releaseId}`);
    process.exit(1);
  }

  // Determine R2 folder from existing release
  const r2Folder = existingRelease.r2FolderPath || `releases/${existingRelease.r2FolderName}`;
  console.log(`R2 folder: ${r2Folder}`);

  // Extract ZIP
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  console.log(`\nZIP contents (${entries.length} files):`);

  const audioFiles = [];
  let artworkEntry = null;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const name = entry.entryName;
    const lower = name.toLowerCase();
    const basename = path.basename(name);
    const size = entry.header.size;

    // Skip macOS junk
    if (basename.startsWith('.') || name.includes('__MACOSX')) continue;

    console.log(`  ${basename} (${(size / 1024 / 1024).toFixed(2)}MB)`);

    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) {
      artworkEntry = entry;
    } else if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.flac') || lower.endsWith('.aiff')) {
      audioFiles.push(entry);
    }
  }

  // Sort audio files by name (usually numbered)
  audioFiles.sort((a, b) => path.basename(a.entryName).localeCompare(path.basename(b.entryName), undefined, { numeric: true }));

  console.log(`\nFound: ${audioFiles.length} audio files, artwork: ${artworkEntry ? 'yes' : 'no'}`);

  if (audioFiles.length === 0) {
    console.error('No audio files found in ZIP');
    process.exit(1);
  }

  // Upload artwork if present
  if (artworkEntry) {
    const artData = artworkEntry.getData();
    const artBasename = path.basename(artworkEntry.entryName);
    const artKey = `${r2Folder}/${artBasename}`;

    console.log(`\nUploading artwork: ${artBasename} (${(artData.length / 1024).toFixed(0)}KB)...`);
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: artKey,
      Body: artData,
      ContentType: artBasename.endsWith('.png') ? 'image/png' : 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    console.log(`  Uploaded to: ${artKey}`);
  }

  // Upload audio files and build track list
  const tracks = [];
  const existingTracks = existingRelease.tracks || [];

  for (let i = 0; i < audioFiles.length; i++) {
    const entry = audioFiles[i];
    const data = entry.getData();
    const basename = path.basename(entry.entryName);
    const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const audioKey = `${r2Folder}/${sanitized}`;
    const audioUrl = `${publicDomain}/${audioKey}`;

    // Derive track name from filename
    const trackNameFromFile = basename
      .replace(/\.(wav|mp3|flac|aiff)$/i, '')
      .replace(/^\d+[\s._-]+/, '')  // Remove leading track number
      .trim();

    // Try to match with existing metadata track
    const existingTrack = existingTracks[i] || {};

    console.log(`\nUploading track ${i + 1}: ${basename} (${(data.length / 1024 / 1024).toFixed(1)}MB)...`);
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: audioKey,
      Body: data,
      ContentType: basename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    console.log(`  Uploaded to: ${audioKey}`);

    tracks.push({
      trackNumber: i + 1,
      title: existingTrack.title || trackNameFromFile || `Track ${i + 1}`,
      trackName: existingTrack.trackName || trackNameFromFile || `Track ${i + 1}`,
      mp3Url: audioUrl,
      wavUrl: audioUrl,
      previewUrl: audioUrl,
      bpm: existingTrack.bpm || '',
      key: existingTrack.key || '',
      duration: existingTrack.duration || '',
      trackISRC: existingTrack.trackISRC || '',
      featured: existingTrack.featured || '',
      remixer: existingTrack.remixer || '',
      storage: 'r2',
    });

    console.log(`  Track ${i + 1}: "${tracks[i].title}" -> ${audioUrl}`);
  }

  // Update Firebase release with new tracks
  console.log(`\nUpdating Firebase release: ${releaseId}`);
  console.log(`  Tracks: ${tracks.length}`);

  const updates = {
    tracks: tracks,
    updatedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
  };

  await updateFirestoreDoc(releaseId, updates);
  console.log('  Firebase updated successfully!');

  console.log(`\n=== Done ===`);
  console.log(`Release: ${existingRelease.artistName} - ${existingRelease.releaseName}`);
  console.log(`Tracks: ${tracks.length}`);
  tracks.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} -> ${t.mp3Url}`));
  console.log(`\nMetadata preserved: pricing, copyright, genre, description, label code, etc.`);
  console.log(`Status is still: ${existingRelease.status} — approve from admin when ready.`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
