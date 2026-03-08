// Check if submission folder still exists and what's in it
const submissionId = process.argv[2] || 'Elipse___Draai-1772822313703';

async function checkFolder(prefix) {
  // Try CDN HEAD requests for common files
  const files = [
    'info.json', 'metadata.json',
    'cover.jpg', 'cover.png', 'cover.webp', 'artwork.jpg', 'artwork.png',
  ];

  let found = false;
  for (const f of files) {
    try {
      const res = await fetch(`https://cdn.freshwax.co.uk/${prefix}/${f}`, { method: 'HEAD' });
      if (res.ok) {
        const size = res.headers.get('content-length');
        console.log(`  EXISTS: ${prefix}/${f} (${(parseInt(size || '0') / 1024).toFixed(1)}KB)`);
        found = true;
      }
    } catch (e) { /* skip */ }
  }
  return found;
}

async function main() {
  console.log('Checking submissions/ folder...');
  const sub1 = await checkFolder(`submissions/${submissionId}`);

  console.log('\nChecking root level...');
  const sub2 = await checkFolder(submissionId);

  if (!sub1 && !sub2) {
    console.log('\nSubmission folder appears to be deleted (files were cleaned up after processing).');
    console.log('The release data needs to be fixed directly in Firebase.');
  }
}

main().catch(console.error);
