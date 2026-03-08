// Fetch full release data from Firebase and save to JSON
const fs = require('fs');
const releaseId = process.argv[2] || 'elipse_draai_FW-1772922642977';
const projectId = 'freshwax-store';

async function main() {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases/${releaseId}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`Failed to fetch release: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const doc = await res.json();

  if (!doc.fields) {
    console.error('No fields found in document');
    process.exit(1);
  }

  // Convert Firestore format to plain object
  function parseValue(val) {
    if (!val) return null;
    if ('stringValue' in val) return val.stringValue;
    if ('integerValue' in val) return parseInt(val.integerValue);
    if ('doubleValue' in val) return val.doubleValue;
    if ('booleanValue' in val) return val.booleanValue;
    if ('nullValue' in val) return null;
    if ('timestampValue' in val) return val.timestampValue;
    if ('mapValue' in val) {
      const obj = {};
      const fields = val.mapValue.fields || {};
      for (const [k, v] of Object.entries(fields)) {
        obj[k] = parseValue(v);
      }
      return obj;
    }
    if ('arrayValue' in val) {
      return (val.arrayValue.values || []).map(parseValue);
    }
    return JSON.stringify(val);
  }

  const data = {};
  for (const [key, val] of Object.entries(doc.fields)) {
    data[key] = parseValue(val);
  }

  // Pretty print key info
  console.log('\n=== Release Metadata ===');
  console.log(`ID: ${data.id}`);
  console.log(`Artist: ${data.artistName}`);
  console.log(`Title: ${data.releaseName}`);
  console.log(`Genre: ${data.genre}`);
  console.log(`Status: ${data.status}`);
  console.log(`Price: £${data.pricePerSale}`);
  console.log(`Track Price: £${data.trackPrice}`);
  console.log(`Copyright: ${data.copyrightYear} ${data.copyrightHolder}`);
  console.log(`Email: ${data.email}`);
  console.log(`Submission ID: ${data.submissionId}`);
  console.log(`Release Date: ${data.releaseDate}`);
  console.log(`Description: ${data.releaseDescription || data.description || '(none)'}`);
  console.log(`Mastered By: ${data.masteredBy || '(none)'}`);
  console.log(`Label Code: ${data.labelCode || data.catalogNumber || '(none)'}`);
  console.log(`Vinyl: ${data.vinylRelease}`);
  console.log(`Cover URL: ${data.coverUrl}`);
  console.log(`Tracks (${(data.tracks || []).length}):`);
  (data.tracks || []).forEach((t, i) => {
    console.log(`  ${i+1}. ${t.title || t.trackName || '?'} (BPM: ${t.bpm || '?'}, Key: ${t.key || '?'})`);
    console.log(`     URL: ${t.mp3Url || t.wavUrl || '?'}`);
  });

  // Save full data to JSON
  const outPath = `scripts/release-${releaseId}.json`;
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nFull data saved to: ${outPath}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
