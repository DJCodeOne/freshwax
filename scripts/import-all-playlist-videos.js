// Script to import ALL playlist videos to Firebase
// Supports multiple playlists - just add more playlist IDs to the array

const FIREBASE_PROJECT_ID = 'freshwax-store';
const FIREBASE_API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

// Add playlist IDs here to import multiple playlists
const PLAYLIST_IDS = [
  'PLUEZ0bliZydPwv-rCpu7kUKCPG-EsGANd', // Main playlist
  'PLUEZ0bliZydOmk74ZEUxwoLvp6xEjjCHn', // Playlist 2
  'PLUEZ0bliZydMtTPDqxMas9Qifen0moCKC', // Playlist 3
  'PLSjDcvSz6RqMXQ838hXbunXqnEUzgih0P', // Playlist 4
  'PLSjDcvSz6RqMLvm_oElZyCbOpcBsYVVUO', // Playlist 5
  'PLSjDcvSz6RqOJrurS0ek02LRnz2xLrZLS', // Playlist 6
  'PLSjDcvSz6RqML5dW418b63TJU56-HqaKg', // Playlist 7
  'PLSjDcvSz6RqMd056ZHRIML84NiNKLPRU1', // Playlist 8
  'PLSjDcvSz6RqOzp1MAMqnUARw2iTD3-tSL', // Playlist 9
  'PLSjDcvSz6RqMmtOD7CMi2QcBIzIwTOQj2', // Playlist 10
  'PLSjDcvSz6RqM8CwbmKqnujpD-yZ3YMr-X', // Playlist 11
  'PLSjDcvSz6RqPndXZ8HUwdztKdWBhgWRbR', // Playlist 12
  'PLurCdizYrXX7gSJorGBQqzfslF02gphHw', // Playlist 13
  'PLurCdizYrXX409OJB1iaxqb236Zu8-opC', // Playlist 14
  'PL64312D831465E06C', // Playlist 15
  'PL7DE55B65879ECDAA', // Playlist 16
  'PLDCD3FE1BFEC03393', // Playlist 17
  'PL874BE6D5137D5DCF', // Playlist 18
  'PL8EF5776F550046EE', // Playlist 19
  'PL70EAAE8B1A6D118B', // Playlist 20
  'PLC969BEEE5FAC0B88', // Playlist 21
  'PL8ED6EF14456CD126', // Playlist 22
  'PLurCdizYrXX5lCipX1CrEbwaTPIEBEKlc', // Playlist 23
  'PLBQ27ktdLbhvU5hkJ6M0QgtFJD2M9-b8C', // Playlist 24
  'PLBQ27ktdLbhthIgdii67t-WZCDabgo0e9', // Playlist 25
  'PLBQ27ktdLbhsdqGbap2enef3QNndlTqTR', // Playlist 26
  'PLBQ27ktdLbhumbycw2yOAMSmn4bLTVZng', // Playlist 27
  'PLBQ27ktdLbhuIY96kmS_zvbtSh8HpTaTS', // Playlist 28
  'PLBQ27ktdLbhueqtXucKxgJ2TeUBgc9OvD', // Playlist 29
  'PLBQ27ktdLbhsSjTtAq803hABiDzjKx_pB', // Playlist 30
  'PLBQ27ktdLbht9-K5Y2o7VXObjcDsKu2Ml', // Playlist 31
  'PLBQ27ktdLbhvbqFkP42SRQsXUj0zzfuc_', // Playlist 32
  'PLBQ27ktdLbhu9MZIcD5-f99jx9WCIRrxq', // Playlist 33
];

async function fetchPlaylistPage(playlistId, continuation = null) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
  };

  if (!continuation) {
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    const response = await fetch(url, { headers });
    return { type: 'html', data: await response.text() };
  } else {
    const url = 'https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const body = JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20231219.04.00' } },
      continuation: continuation
    });
    const response = await fetch(url, { method: 'POST', headers, body });
    return { type: 'json', data: await response.json() };
  }
}

function extractVideoIds(content, type) {
  const str = type === 'html' ? content : JSON.stringify(content);
  const videoIds = [];
  const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  const seen = new Set();
  while ((match = idRegex.exec(str)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      videoIds.push(match[1]);
    }
  }
  return videoIds;
}

function extractContinuation(content, type) {
  const str = type === 'html' ? content : JSON.stringify(content);
  const match = str.match(/"token":"([^"]{50,})"/);
  return match ? match[1] : null;
}

async function fetchAllVideosFromPlaylist(playlistId) {
  const allVideoIds = [];
  let page = 1;

  console.log(`\nFetching playlist: ${playlistId}`);

  let result = await fetchPlaylistPage(playlistId);
  let ids = extractVideoIds(result.data, result.type);
  allVideoIds.push(...ids);
  console.log(`  Page ${page}: ${ids.length} videos (Total: ${allVideoIds.length})`);

  let continuation = extractContinuation(result.data, result.type);

  while (continuation && page < 50) {
    page++;
    try {
      result = await fetchPlaylistPage(playlistId, continuation);
      ids = extractVideoIds(result.data, result.type);
      allVideoIds.push(...ids);
      console.log(`  Page ${page}: ${ids.length} videos (Total: ${allVideoIds.length})`);
      continuation = extractContinuation(result.data, result.type);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`  Page ${page}: Error - ${err.message}`);
      break;
    }
  }

  return allVideoIds;
}

async function getYouTubeTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (res.ok) {
      const data = await res.json();
      return data.title;
    }
  } catch (e) {}
  return null;
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

const CHUNK_SIZE = 2500; // ~625KB per chunk, well under 1MB limit

async function saveToFirebase(items) {
  // Split into chunks to stay under 1MB document limit
  const chunks = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Splitting ${items.length} videos into ${chunks.length} documents...`);

  for (let i = 0; i < chunks.length; i++) {
    const docName = i === 0 ? 'playlistHistory' : `playlistHistory_${i}`;
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/liveSettings/${docName}?key=${FIREBASE_API_KEY}`;

    const body = {
      fields: {
        items: { arrayValue: { values: chunks[i].map(toFirestoreValue) } },
        lastUpdated: { stringValue: new Date().toISOString() },
        totalVideos: { integerValue: items.length.toString() },
        chunkIndex: { integerValue: i.toString() },
        totalChunks: { integerValue: chunks.length.toString() }
      }
    };

    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Failed to save chunk ${i}: ${await response.text()}`);
    }
    console.log(`  Saved chunk ${i + 1}/${chunks.length} (${chunks[i].length} videos)`);
  }
}

async function main() {
  const allVideoIds = new Set();

  // Fetch from all playlists
  for (const playlistId of PLAYLIST_IDS) {
    const ids = await fetchAllVideosFromPlaylist(playlistId);
    ids.forEach(id => allVideoIds.add(id));
  }

  console.log(`\n=== Total unique videos: ${allVideoIds.size} ===\n`);

  // Convert to items array
  const items = Array.from(allVideoIds).map((id, index) => ({
    id: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    platform: 'youtube',
    embedId: id,
    title: `Track ${index + 1}`, // Will fetch titles separately
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    playedAt: new Date().toISOString(),
    addedBy: 'system',
    addedByName: 'Playlist Import'
  }));

  // Save to Firebase
  console.log('Saving to Firebase...');
  await saveToFirebase(items);
  console.log(`Saved ${items.length} videos to Firebase!`);

  // Fetch titles (optional - takes time)
  const fetchTitles = process.argv.includes('--titles');
  if (fetchTitles) {
    console.log('\nFetching titles (this may take a while)...');
    for (let i = 0; i < items.length; i++) {
      const title = await getYouTubeTitle(items[i].embedId);
      if (title) {
        items[i].title = title;
        process.stdout.write(`\r  ${i + 1}/${items.length}: ${title.substring(0, 50)}...`);
      }
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 500));
    }
    console.log('\n\nSaving titles to Firebase...');
    await saveToFirebase(items);
    console.log('Done!');
  } else {
    console.log('\nRun with --titles flag to fetch YouTube titles');
  }
}

main().catch(console.error);
