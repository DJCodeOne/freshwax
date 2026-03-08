// List files in an R2 folder via the admin API
const folder = process.argv[2] || 'releases/elipse_draai_universal_language_1772922642977';
const SITE = 'https://freshwax.co.uk';

async function main() {
  // Use list-submissions or list-r2-folders to enumerate
  // Actually let's just use the admin list-r2-folders endpoint
  const url = `${SITE}/api/admin/list-r2-folders/`;
  console.log(`Checking R2 for prefix: ${folder}/`);

  // We need admin auth — let's try a different approach
  // Use the presign endpoint to list objects
  // Actually we can't easily list R2 without admin auth from CLI
  // Let's just check what CDN URLs exist by testing them

  const testFiles = [
    `${folder}/cover.webp`,
    `${folder}/thumb.webp`,
    `${folder}/original.jpg`,
    `${folder}/original.png`,
    `${folder}/original.webp`,
  ];

  // Also try common audio file patterns
  const audioPatterns = [
    'DRAAI___JULES_FLUTE_TUNE.wav',
    'Universal_Language.wav',
    'Universal Language.wav',
    '01_Universal_Language.wav',
    '02_Flute_Tune.wav',
    'Flute.wav',
    'Flute_Tune.wav',
    'ELIPSE___DRAAI_UNIVERSAL_LANGUAGE.wav',
    'ELIPSE_DRAAI_UNIVERSAL_LANGUAGE.wav',
  ];

  for (const pattern of audioPatterns) {
    testFiles.push(`${folder}/${pattern}`);
  }

  for (const file of testFiles) {
    try {
      const res = await fetch(`https://cdn.freshwax.co.uk/${file}`, { method: 'HEAD' });
      if (res.ok) {
        const size = res.headers.get('content-length');
        console.log(`  EXISTS: ${file} (${(parseInt(size || '0') / 1024 / 1024).toFixed(2)}MB)`);
      }
    } catch (e) {
      // skip
    }
  }
}

main().catch(console.error);
