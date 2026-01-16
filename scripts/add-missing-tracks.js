// Script to add missing tracks to Curiosity Vol.2
// Run with: node scripts/add-missing-tracks.js

import { config } from 'dotenv';
import crypto from 'crypto';
config();

const projectId = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!clientEmail || !privateKey) {
  console.error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY in .dev.vars');
  process.exit(1);
}

// Simple base64url encode
function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${signatureInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) {
    return (value.arrayValue?.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in value) {
    const result = {};
    for (const [k, v] of Object.entries(value.mapValue?.fields || {})) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  return null;
}

async function main() {
  const releaseId = 'underground_lair_recordings_FW-1768518251667';

  console.log('Getting access token...');
  const token = await getAccessToken();

  console.log('Fetching current release...');
  const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}`;
  const docRes = await fetch(docUrl, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const doc = await docRes.json();
  const currentTracks = fromFirestoreValue(doc.fields.tracks) || [];
  console.log('Current tracks:', currentTracks.length);
  currentTracks.forEach((t, i) => console.log(`  ${i+1}. ${t.trackName}`));

  const baseUrl = 'https://cdn.freshwax.co.uk/releases/underground_lair_recordings_curiosity_vol_2_1768518251667';

  // Check if Mac V track exists, if not add it
  const hasMacV = currentTracks.some(t => t.trackName.includes('Mac V'));
  let tracksWithMacV = [...currentTracks];

  if (!hasMacV) {
    console.log('\nAdding missing Mac V track...');
    tracksWithMacV.push({
      trackName: 'Mac V - Consious Minds',
      trackNumber: 0,
      displayTrackNumber: 0,
      wavUrl: `${baseUrl}/ULR012.Mac%20V%20-%20Consious%20Minds.wav`,
      mp3Url: `${baseUrl}/ULR012.Mac%20V%20-%20Consious%20Minds.wav`,
      previewUrl: `${baseUrl}/ULR012.Mac%20V%20-%20Consious%20Minds.wav`,
      featured: '', remixer: '', trackISRC: '', bpm: 170, key: '', duration: '5:28',
      ratings: { average: 0, count: 0, total: 0 }, comments: []
    });
  }

  // Define artist order
  const artistOrder = [
    'Akinsa',
    'Antares',
    'Bakkus',
    'Botnet',
    'BSoD',
    'Code One',
    'ED808',
    'Gred Lvov',
    'Mac V',
    'Marc OFX',
    'Paludal',
    'Parody',
    'Radiobomb'
  ];

  // Fix track names and set durations/BPM for new tracks
  const trackFixes = {
    'Cold & Dark - Marc OFX': { newName: 'Marc OFX - Cold & Dark', duration: '6:27', bpm: 170 },
    'Shudder - Gred Lvov & Offish': { newName: 'Gred Lvov & Offish - Shudder', duration: '5:16', bpm: 170 },
    'Shudder - Greg Lvov & Offish': { newName: 'Gred Lvov & Offish - Shudder', duration: '5:16', bpm: 170 },
    'Hot Air - Radiobomb': { newName: 'Radiobomb - Hot Air', duration: '3:28', bpm: 170 },
    'Meat Grinder - ED808 & Y2 feat No Lights No Shadows-Beccles': { newName: 'ED808 & Y2 feat NoLightsNoShadows-Beccles - Meat Grinder', duration: '6:43', bpm: 170 }
  };

  const fixedTracks = tracksWithMacV.map(t => {
    const fix = trackFixes[t.trackName];
    if (fix) {
      return { ...t, trackName: fix.newName, duration: fix.duration, bpm: fix.bpm };
    }
    return t;
  });

  // Sort by artist order
  const sortedTracks = [...fixedTracks].sort((a, b) => {
    const aArtist = artistOrder.find(artist => a.trackName.includes(artist)) || 'ZZZ';
    const bArtist = artistOrder.find(artist => b.trackName.includes(artist)) || 'ZZZ';
    return artistOrder.indexOf(aArtist) - artistOrder.indexOf(bArtist);
  });

  console.log('\nReordering by artist and fixing names...');

  // Re-number tracks
  const renumberedTracks = sortedTracks.map((t, i) => ({
    ...t,
    trackNumber: i,
    displayTrackNumber: i + 1
  }));

  console.log('\nFinal track list:');
  renumberedTracks.forEach((t, i) => console.log(`  ${i+1}. ${t.trackName}`));

  console.log('\nUpdating release...');
  const updateUrl = `${docUrl}?updateMask.fieldPaths=tracks`;
  const updateRes = await fetch(updateUrl, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        tracks: toFirestoreValue(renumberedTracks)
      }
    })
  });

  if (updateRes.ok) {
    console.log('SUCCESS! Release now has', renumberedTracks.length, 'tracks');
  } else {
    const error = await updateRes.text();
    console.error('Error:', error);
  }
}

main().catch(console.error);
