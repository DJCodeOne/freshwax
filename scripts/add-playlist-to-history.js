// Script to add YouTube playlist videos to Fresh Wax playlist history
// Run with: node scripts/add-playlist-to-history.js

const FIREBASE_PROJECT_ID = 'freshwax-store';
const FIREBASE_API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

async function fetchPlaylistVideos() {
  console.log('Fetching playlist videos...');

  const response = await fetch('https://www.youtube.com/playlist?list=PLUEZ0bliZydPwv-rCpu7kUKCPG-EsGANd', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  const html = await response.text();

  // Extract video IDs and titles
  const videos = [];
  const videoIds = new Set();

  // Find videoId occurrences
  const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  while ((match = idRegex.exec(html)) !== null) {
    if (!videoIds.has(match[1])) {
      videoIds.add(match[1]);
      videos.push({
        id: match[1],
        url: `https://www.youtube.com/watch?v=${match[1]}`,
        platform: 'youtube',
        embedId: match[1],
        title: `DJ Mix ${videos.length + 1}`, // Will be updated when played
        thumbnail: `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`,
        playedAt: new Date().toISOString(),
        addedBy: 'system',
        addedByName: 'Fresh Wax Playlist Import'
      });
    }
  }

  console.log(`Found ${videos.length} unique videos`);
  return videos;
}

async function getExistingHistory() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/liveSettings/playlistHistory?key=${FIREBASE_API_KEY}`;

  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.fields && data.fields.items && data.fields.items.arrayValue) {
        return data.fields.items.arrayValue.values || [];
      }
    }
  } catch (err) {
    console.log('No existing history found, starting fresh');
  }
  return [];
}

function toFirestoreValue(item) {
  return {
    mapValue: {
      fields: {
        id: { stringValue: item.id },
        url: { stringValue: item.url },
        platform: { stringValue: item.platform },
        embedId: { stringValue: item.embedId },
        title: { stringValue: item.title },
        thumbnail: { stringValue: item.thumbnail },
        playedAt: { stringValue: item.playedAt },
        addedBy: { stringValue: item.addedBy || '' },
        addedByName: { stringValue: item.addedByName || '' }
      }
    }
  };
}

async function saveHistory(items) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/liveSettings/playlistHistory?key=${FIREBASE_API_KEY}`;

  const firestoreItems = items.map(toFirestoreValue);

  const body = {
    fields: {
      items: {
        arrayValue: {
          values: firestoreItems
        }
      },
      lastUpdated: {
        stringValue: new Date().toISOString()
      }
    }
  };

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to save: ${error}`);
  }

  return await response.json();
}

async function main() {
  try {
    // Fetch new videos
    const newVideos = await fetchPlaylistVideos();

    // Get existing history
    const existingHistory = await getExistingHistory();
    console.log(`Existing history has ${existingHistory.length} items`);

    // Convert existing to simple format for dedup
    const existingUrls = new Set();
    const existingItems = existingHistory.map(item => {
      const fields = item.mapValue?.fields || {};
      const url = fields.url?.stringValue || '';
      existingUrls.add(url);
      return {
        id: fields.id?.stringValue || '',
        url: url,
        platform: fields.platform?.stringValue || 'youtube',
        embedId: fields.embedId?.stringValue || '',
        title: fields.title?.stringValue || '',
        thumbnail: fields.thumbnail?.stringValue || '',
        playedAt: fields.playedAt?.stringValue || new Date().toISOString(),
        addedBy: fields.addedBy?.stringValue || '',
        addedByName: fields.addedByName?.stringValue || ''
      };
    });

    // Add new videos that don't exist
    let addedCount = 0;
    for (const video of newVideos) {
      if (!existingUrls.has(video.url)) {
        existingItems.push(video);
        addedCount++;
      }
    }

    console.log(`Adding ${addedCount} new videos to history`);

    // Save combined history (limit to 100)
    const finalItems = existingItems.slice(0, 100);
    await saveHistory(finalItems);

    console.log(`Successfully saved ${finalItems.length} items to playlist history`);
    console.log('Done!');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
