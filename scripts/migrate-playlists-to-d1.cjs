// Migrate user playlists from Firestore to D1
// Run: node scripts/migrate-playlists-to-d1.cjs

const FIREBASE_API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
const PROJECT_ID = 'freshwax-store';

async function fetchPlaylistsFromFirestore() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/userPlaylists?key=${FIREBASE_API_KEY}&pageSize=100`;

  const response = await fetch(url);
  const data = await response.json();

  if (!data.documents) {
    console.log('No playlists found in Firestore');
    return [];
  }

  const playlists = [];

  for (const doc of data.documents) {
    const userId = doc.name.split('/').pop();
    const items = doc.fields?.items?.arrayValue?.values || [];

    const playlistItems = items.map(item => {
      const fields = item.mapValue?.fields || {};
      return {
        id: fields.id?.stringValue || '',
        url: fields.url?.stringValue || '',
        platform: fields.platform?.stringValue || 'youtube',
        title: fields.title?.stringValue || '',
        thumbnail: fields.thumbnail?.stringValue || '',
        embedId: fields.embedId?.stringValue || '',
        addedAt: fields.addedAt?.stringValue || new Date().toISOString()
      };
    });

    playlists.push({
      userId,
      items: playlistItems
    });

    console.log(`Found playlist for user ${userId}: ${playlistItems.length} items`);
  }

  return playlists;
}

function generateD1InsertStatements(playlists) {
  const statements = [];

  for (const playlist of playlists) {
    const playlistJson = JSON.stringify(playlist.items).replace(/'/g, "''");
    const now = new Date().toISOString();

    statements.push(`INSERT INTO user_playlists (user_id, playlist, updated_at) VALUES ('${playlist.userId}', '${playlistJson}', '${now}') ON CONFLICT(user_id) DO UPDATE SET playlist = excluded.playlist, updated_at = excluded.updated_at;`);
  }

  return statements;
}

async function main() {
  console.log('Fetching playlists from Firestore...');
  const playlists = await fetchPlaylistsFromFirestore();

  if (playlists.length === 0) {
    console.log('No playlists to migrate');
    return;
  }

  console.log(`\nFound ${playlists.length} playlists to migrate\n`);

  const statements = generateD1InsertStatements(playlists);

  console.log('Generated D1 SQL statements:');
  console.log('---');
  for (const stmt of statements) {
    console.log(stmt);
  }
  console.log('---');

  console.log('\nTo run these statements, use:');
  console.log('CLOUDFLARE_ACCOUNT_ID=5f6ae0dd5c6f5c83e2d1aa0fa8928ff4 npx wrangler d1 execute freshwax-db --remote --command "YOUR_SQL_HERE"');
}

main().catch(console.error);
