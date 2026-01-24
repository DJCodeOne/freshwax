const http = require('http');

const options = {
  hostname: '::1',
  port: 4321,
  path: '/api/get-releases',
  method: 'GET',
  family: 6
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    const releases = json.releases || [];

    // Find releases that have proper MP3 files
    const ready = releases.filter(r => {
      const tracks = r.tracks || [];
      if (tracks.length === 0) return false;
      return tracks.every(t => {
        const mp3 = (t.mp3Url || '').toLowerCase();
        const wav = (t.wavUrl || '').toLowerCase();
        const hasMp3 = mp3.includes('.mp3');
        const hasWav = wav.includes('.wav') || wav.includes('.flac');
        const different = t.mp3Url !== t.wavUrl;
        return hasMp3 && hasWav && different;
      });
    });

    console.log('Ready releases with MP3 files:\n');
    ready.forEach(r => {
      console.log(r.artist + ' - ' + r.title);
      (r.tracks || []).slice(0, 2).forEach(t => {
        console.log('  MP3: ' + t.mp3Url);
      });
      if ((r.tracks || []).length > 2) {
        console.log('  ... and ' + (r.tracks.length - 2) + ' more tracks');
      }
      console.log('');
    });

    // Output first MP3 URL for quality check
    if (ready.length > 0 && ready[0].tracks && ready[0].tracks[0]) {
      console.log('\n--- First MP3 URL for quality check ---');
      console.log(ready[0].tracks[0].mp3Url);
    }
  });
});

req.on('error', e => console.error('Error:', e.message));
req.end();
