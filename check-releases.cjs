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
    try {
      const json = JSON.parse(data);
      const releases = json.releases || [];

      console.log('\n=== RELEASES AUDIO FORMAT CHECK ===\n');

      const needsProcessing = [];
      const ready = [];

      releases.forEach(r => {
        const tracks = r.tracks || [];
        let missing = [];

        tracks.forEach(t => {
          const num = t.displayTrackNumber || (t.trackNumber + 1);
          const mp3Url = t.mp3Url || '';
          const wavUrl = t.wavUrl || '';

          // Check if both formats exist AND are different files (not same URL)
          const hasMp3 = mp3Url && mp3Url.toLowerCase().includes('.mp3');
          const hasWav = wavUrl && (wavUrl.toLowerCase().includes('.wav') || wavUrl.toLowerCase().includes('.flac'));

          // Also check if both URLs are the same (means one format is missing)
          const sameUrl = mp3Url === wavUrl;

          if (!hasMp3 || !hasWav || sameUrl) {
            missing.push({
              track: num,
              mp3: hasMp3 ? 'yes' : (mp3Url ? 'wrong format' : 'NO'),
              wav: hasWav ? 'yes' : (wavUrl ? 'wrong format' : 'NO'),
              sameUrl: sameUrl
            });
          }
        });

        if (missing.length > 0) {
          needsProcessing.push({ title: r.title, artist: r.artist, id: r.id, missing, status: r.status });
        } else {
          ready.push({ title: r.title, artist: r.artist, id: r.id, status: r.status });
        }
      });

      console.log('❌ NEEDS PROCESSING (' + needsProcessing.length + '):\n');
      needsProcessing.forEach(r => {
        console.log(`  ${r.artist} - ${r.title} [${r.status || 'unknown'}]`);
        console.log(`    ID: ${r.id}`);
        r.missing.forEach(m => {
          const issue = m.sameUrl ? '(same URL for both)' : '';
          console.log(`    Track ${m.track}: MP3=${m.mp3}, WAV=${m.wav} ${issue}`);
        });
        console.log('');
      });

      console.log('\n✅ READY FOR SALE (' + ready.length + '):\n');
      ready.forEach(r => {
        console.log(`  ${r.artist} - ${r.title} [${r.status || 'unknown'}]`);
      });

    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
});

req.end();
