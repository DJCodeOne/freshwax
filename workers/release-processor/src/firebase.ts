// firebase.ts - Firebase REST API integration for release processor
// Simplified version for Cloudflare Workers environment

import type { Env, ProcessedRelease, ProcessedTrack } from './types';

const PROJECT_ID = 'freshwax-store';

/**
 * Convert JavaScript value to Firestore value format
 */
function toFirestoreValue(value: any): any {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const mapValue: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      mapValue[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields: mapValue } };
  }
  return { stringValue: String(value) };
}

/**
 * Set a document in Firestore (create or update)
 */
async function setDocument(
  collection: string,
  docId: string,
  data: Record<string, any>,
  env: Env
): Promise<{ success: boolean; id: string }> {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${env.FIREBASE_API_KEY}`;

  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Firebase] setDocument error:', response.status, errorText);
    throw new Error(`Failed to set document: ${response.status}`);
  }

  console.log(`[Firebase] Document set: ${collection}/${docId}`);
  return { success: true, id: docId };
}

/**
 * Get a document from Firestore
 */
async function getDocument(
  collection: string,
  docId: string,
  env: Env
): Promise<any | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${env.FIREBASE_API_KEY}`;

  const response = await fetch(url);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Firebase] getDocument error:', response.status, errorText);
    throw new Error(`Failed to get document: ${response.status}`);
  }

  const doc = await response.json();
  return parseFirestoreDocument(doc);
}

/**
 * Parse Firestore document to plain JavaScript object
 */
function parseFirestoreDocument(doc: any): any {
  if (!doc.fields) return null;

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(doc.fields)) {
    result[key] = parseFirestoreValue(value as any);
  }
  return result;
}

/**
 * Parse Firestore value to JavaScript value
 */
function parseFirestoreValue(value: any): any {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(parseFirestoreValue);
  }
  if ('mapValue' in value) {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value.mapValue.fields || {})) {
      result[k] = parseFirestoreValue(v);
    }
    return result;
  }
  return null;
}

/**
 * Create release document in Firebase
 */
export async function createReleaseInFirebase(
  release: ProcessedRelease,
  env: Env
): Promise<void> {
  console.log(`[Firebase] Creating release: ${release.id}`);

  // Create the main release document
  const releaseData = {
    id: release.id,
    title: release.title || release.releaseName,
    artist: release.artist || release.artistName,
    artistName: release.artistName,
    releaseName: release.releaseName,
    coverUrl: release.coverUrl,
    artworkUrl: release.coverUrl,
    thumbUrl: release.thumbUrl,
    genre: release.genre || '',
    catalogNumber: release.catalogNumber || '',
    releaseDate: release.releaseDate || new Date().toISOString(),
    description: release.description || '',
    pricePerSale: release.pricePerSale || 7.99,
    trackPrice: release.trackPrice || 1.99,
    vinylPrice: release.vinylPrice || 0,
    vinylRelease: release.vinylRelease || false,
    status: 'pending',
    published: false,
    approved: false,
    storage: 'r2',
    tracks: release.tracks.map((track, index) => ({
      track_number: track.trackNumber,
      trackNumber: track.trackNumber,
      title: track.title,
      url: track.mp3Url,
      mp3Url: track.mp3Url,
      wavUrl: track.wavUrl,
      preview_url: track.previewUrl,
      previewUrl: track.previewUrl,
      bpm: track.bpm || null,
      key: track.key || null,
      duration: track.duration || 0,
      storage: 'r2',
      previewStorage: 'r2'
    })),
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
    processedAt: release.processedAt,
    plays: 0,
    downloads: 0,
    views: 0,
    likes: 0,
    ratings: {
      average: 0,
      count: 0,
      total: 0
    }
  };

  await setDocument('releases', release.id, releaseData, env);

  // Update the master releases list
  await updateMasterReleasesList(release, env);

  console.log(`[Firebase] Release created successfully: ${release.id}`);
}

/**
 * Update the master releases list document
 */
async function updateMasterReleasesList(
  release: ProcessedRelease,
  env: Env
): Promise<void> {
  console.log('[Firebase] Updating master releases list...');

  // Get current master list
  const masterList = await getDocument('system', 'releases-master', env);

  let releasesList: any[] = [];
  if (masterList && masterList.releases) {
    releasesList = masterList.releases;
  }

  // Check if release already exists
  const existingIndex = releasesList.findIndex((r: any) => r.id === release.id);

  // Create summary for master list
  const releaseSummary = {
    id: release.id,
    title: release.title || release.releaseName,
    artist: release.artist || release.artistName,
    coverUrl: release.coverUrl,
    published: false,
    approved: false,
    status: 'pending',
    releaseDate: release.releaseDate,
    updatedAt: release.updatedAt,
    storage: 'r2'
  };

  if (existingIndex >= 0) {
    releasesList[existingIndex] = releaseSummary;
    console.log('[Firebase] Updated existing release in master list');
  } else {
    releasesList.push(releaseSummary);
    console.log('[Firebase] Added new release to master list');
  }

  // Update master list document
  await setDocument('system', 'releases-master', {
    releases: releasesList,
    totalReleases: releasesList.length,
    lastUpdated: new Date().toISOString()
  }, env);

  console.log(`[Firebase] Master list updated (${releasesList.length} total releases)`);
}
