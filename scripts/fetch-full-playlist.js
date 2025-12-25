// Script to fetch ALL videos from a YouTube playlist using continuation tokens
const PLAYLIST_ID = 'PLUEZ0bliZydPwv-rCpu7kUKCPG-EsGANd';

async function fetchPlaylistPage(continuation = null) {
  let url, body, headers;

  headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
  };

  if (!continuation) {
    // Initial request - get the playlist page
    url = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
    const response = await fetch(url, { headers });
    return await response.text();
  } else {
    // Continuation request - use YouTube's internal API
    url = 'https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    body = JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20231219.04.00'
        }
      },
      continuation: continuation
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body
    });
    return await response.json();
  }
}

function extractVideoIds(html) {
  const videoIds = [];
  const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  const seen = new Set();

  while ((match = idRegex.exec(html)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      videoIds.push(match[1]);
    }
  }
  return videoIds;
}

function extractContinuation(html) {
  // Look for continuation token in various formats
  const patterns = [
    /"continuationCommand":\{"token":"([^"]+)"/,
    /"continuation":"([^"]+)"/,
    /continuationEndpoint.*?"token":"([^"]+)"/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractVideoIdsFromJson(json) {
  const videoIds = [];
  const jsonStr = JSON.stringify(json);
  const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  const seen = new Set();

  while ((match = idRegex.exec(jsonStr)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      videoIds.push(match[1]);
    }
  }
  return videoIds;
}

function extractContinuationFromJson(json) {
  const jsonStr = JSON.stringify(json);
  const match = jsonStr.match(/"token":"([^"]{50,})"/);
  return match ? match[1] : null;
}

async function main() {
  const allVideoIds = new Set();
  let page = 1;

  console.log('Fetching playlist videos...\n');

  // First page
  console.log(`Page ${page}: Fetching initial page...`);
  let html = await fetchPlaylistPage();
  let ids = extractVideoIds(html);
  ids.forEach(id => allVideoIds.add(id));
  console.log(`Page ${page}: Found ${ids.length} videos (Total: ${allVideoIds.size})`);

  let continuation = extractContinuation(html);

  // Subsequent pages
  while (continuation && page < 20) { // Safety limit
    page++;
    console.log(`Page ${page}: Fetching continuation...`);

    try {
      const json = await fetchPlaylistPage(continuation);
      ids = extractVideoIdsFromJson(json);
      ids.forEach(id => allVideoIds.add(id));
      console.log(`Page ${page}: Found ${ids.length} videos (Total: ${allVideoIds.size})`);

      continuation = extractContinuationFromJson(json);

      // Small delay
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`Page ${page}: Error - ${err.message}`);
      break;
    }
  }

  console.log(`\n=== Total unique videos: ${allVideoIds.size} ===\n`);

  // Output all video IDs
  const videoArray = Array.from(allVideoIds);
  videoArray.forEach((id, i) => {
    console.log(`${i + 1}. https://www.youtube.com/watch?v=${id}`);
  });

  // Also save to a JSON file for import
  const fs = require('fs');
  fs.writeFileSync('scripts/playlist-videos.json', JSON.stringify(videoArray, null, 2));
  console.log('\nSaved to scripts/playlist-videos.json');
}

main().catch(console.error);
