// scripts/export-playlist-urls.js
// Exports all playlist history URLs to a text file for yt-dlp

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = 'H:\\FreshWax-Backup';
const URLS_FILE = path.join(OUTPUT_DIR, 'playlist-urls.txt');
const METADATA_FILE = path.join(OUTPUT_DIR, 'playlist-metadata.json');

async function fetchPlaylistHistory() {
  return new Promise((resolve, reject) => {
    https.get('https://freshwax.co.uk/api/playlist/history', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching playlist history from FreshWax...');

  try {
    const result = await fetchPlaylistHistory();

    if (!result.success || !result.items) {
      console.error('Failed to fetch playlist:', result.error);
      process.exit(1);
    }

    const items = result.items;
    console.log(`Found ${items.length} tracks in history`);

    // Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      console.log(`Created directory: ${OUTPUT_DIR}`);
    }

    // Filter YouTube URLs only (yt-dlp works best with YouTube)
    const youtubeItems = items.filter(item =>
      item.platform === 'youtube' && item.url
    );

    console.log(`${youtubeItems.length} YouTube tracks to download`);

    // Extract unique URLs (avoid duplicates)
    const uniqueUrls = [...new Set(youtubeItems.map(item => item.url))];
    console.log(`${uniqueUrls.length} unique URLs after deduplication`);

    // Write URLs file (one per line for yt-dlp batch mode)
    fs.writeFileSync(URLS_FILE, uniqueUrls.join('\n'), 'utf8');
    console.log(`Saved URLs to: ${URLS_FILE}`);

    // Write metadata file (for reference)
    const metadata = youtubeItems.map(item => ({
      id: item.embedId || item.id,
      url: item.url,
      title: item.title,
      addedBy: item.addedByName,
      playedAt: item.playedAt
    }));
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`Saved metadata to: ${METADATA_FILE}`);

    // Calculate estimated storage
    const avgSizeMB = 50; // Average video ~50MB at 720p
    const estimatedGB = (uniqueUrls.length * avgSizeMB) / 1024;
    console.log(`\nEstimated storage needed: ~${estimatedGB.toFixed(0)} GB (at 720p)`);
    console.log(`You have 500GB available, this should fit easily.\n`);

    console.log('Next steps:');
    console.log('1. Install yt-dlp: pip install yt-dlp');
    console.log('   Or download from: https://github.com/yt-dlp/yt-dlp/releases');
    console.log('2. Run the download script: download-playlist.bat');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
