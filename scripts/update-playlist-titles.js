// Script to fetch actual YouTube titles and update playlist history
const FIREBASE_PROJECT_ID = 'freshwax-store';
const FIREBASE_API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

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

async function getExistingHistory() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/liveSettings/playlistHistory?key=${FIREBASE_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!data.fields?.items?.arrayValue?.values) return [];

  return data.fields.items.arrayValue.values.map(item => {
    const fields = item.mapValue?.fields || {};
    return {
      id: fields.id?.stringValue || '',
      url: fields.url?.stringValue || '',
      platform: fields.platform?.stringValue || 'youtube',
      embedId: fields.embedId?.stringValue || '',
      title: fields.title?.stringValue || '',
      thumbnail: fields.thumbnail?.stringValue || '',
      playedAt: fields.playedAt?.stringValue || new Date().toISOString(),
      addedBy: fields.addedBy?.stringValue || '',
      addedByName: fields.addedByName?.stringValue || ''
    };
  });
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

  const body = {
    fields: {
      items: { arrayValue: { values: items.map(toFirestoreValue) } },
      lastUpdated: { stringValue: new Date().toISOString() }
    }
  };

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to save: ${await response.text()}`);
  }
}

async function main() {
  console.log('Fetching existing history...');
  const items = await getExistingHistory();
  console.log(`Found ${items.length} items`);

  console.log('Fetching YouTube titles...\n');
  let updated = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = await getYouTubeTitle(item.embedId);

    if (title) {
      item.title = title;
      updated++;
      console.log(`${i + 1}. ${title}`);
    } else {
      console.log(`${i + 1}. [unavailable] ${item.embedId}`);
    }

    // Small delay to avoid rate limiting
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nUpdating ${updated} titles in Firebase...`);
  await saveHistory(items);
  console.log('Done!');
}

main().catch(console.error);
