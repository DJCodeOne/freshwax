// Check latest releases in Firebase
const projectId = 'freshwax-store';
const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases?pageSize=5&orderBy=createdAt%20desc`;

fetch(url).then(r => r.json()).then(data => {
  if (!data.documents) { console.log('No docs found', JSON.stringify(data).slice(0, 500)); return; }
  data.documents.forEach(doc => {
    const fields = doc.fields || {};
    const id = fields.id?.stringValue || 'unknown';
    const artist = fields.artistName?.stringValue || '';
    const title = fields.releaseName?.stringValue || '';
    const subId = fields.submissionId?.stringValue || '';
    const status = fields.status?.stringValue || '';
    const tracks = fields.tracks?.arrayValue?.values || [];
    console.log(`\n${id} | ${artist} - ${title} | sub: ${subId} | status: ${status} | tracks: ${tracks.length}`);
    tracks.forEach((t, i) => {
      const tf = t.mapValue?.fields || {};
      console.log(`  Track ${i+1}: ${tf.title?.stringValue || '?'} -> ${tf.mp3Url?.stringValue || '?'}`);
    });
  });
}).catch(e => console.error(e));
