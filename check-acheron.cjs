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
    const release = json.releases.find(r => r.id === 'antares_FW-1768396901495');

    if (!release) {
      console.log('Release not found');
      return;
    }

    console.log('Release:', release.artist, '-', release.title);
    console.log('Audio Processed:', release.audioProcessed || false);
    console.log('Processed At:', release.audioProcessedAt || 'N/A');
    console.log('\nTracks:');

    (release.tracks || []).forEach(t => {
      const num = t.displayTrackNumber || (t.trackNumber + 1);
      console.log('  Track ' + num + ': ' + t.trackName);
      console.log('    MP3: ' + (t.mp3Url || 'MISSING'));
      console.log('    WAV: ' + (t.wavUrl || 'MISSING'));

      const mp3Ok = (t.mp3Url || '').toLowerCase().includes('.mp3');
      const wavOk = (t.wavUrl || '').toLowerCase().includes('.wav');
      const different = t.mp3Url !== t.wavUrl;

      if (mp3Ok && wavOk && different) {
        console.log('    Status: ✅ OK');
      } else {
        console.log('    Status: ❌ NEEDS PROCESSING');
      }
    });
  });
});

req.on('error', e => console.error('Error:', e.message));
req.end();
