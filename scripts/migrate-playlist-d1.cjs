// Run directly against D1 using wrangler
// Usage: node scripts/migrate-playlist-d1.cjs

const { execSync } = require('child_process');

const FIREBASE_API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
const PROJECT_ID = 'freshwax-store';

async function fetchPlaylistsFromFirestore() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/userPlaylists?key=${FIREBASE_API_KEY}&pageSize=100`;
  const response = await fetch(url);
  const data = await response.json();

  if (!data.documents) return [];

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

    if (playlistItems.length > 0) {
      playlists.push({ userId, items: playlistItems });
    }
  }
  return playlists;
}

async function main() {
  console.log('Fetching playlists from Firestore...');
  const playlists = await fetchPlaylistsFromFirestore();

  if (playlists.length === 0) {
    console.log('No playlists to migrate');
    return;
  }

  console.log(`Found ${playlists.length} non-empty playlists to migrate\n`);

  for (const playlist of playlists) {
    const playlistJson = JSON.stringify(playlist.items);
    const now = new Date().toISOString();

    // Escape for SQL - double single quotes
    const escapedJson = playlistJson.replace(/'/g, "''");

    const sql = `INSERT INTO user_playlists (user_id, playlist, updated_at) VALUES ('${playlist.userId}', '${escapedJson}', '${now}') ON CONFLICT(user_id) DO UPDATE SET playlist = excluded.playlist, updated_at = excluded.updated_at`;

    console.log(`Migrating playlist for ${playlist.userId} (${playlist.items.length} items)...`);

    try {
      // Write SQL to temp file
      const fs = require('fs');
      const tempFile = 'C:\\Users\\Owner\\freshwax\\temp-migrate.sql';
      fs.writeFileSync(tempFile, sql);

      // Execute via wrangler
      const result = execSync(
        `CLOUDFLARE_ACCOUNT_ID=5f6ae0dd5c6f5c83e2d1aa0fa8928ff4 npx wrangler d1 execute freshwax-db --remote --file="${tempFile}"`,
        { cwd: 'C:\\Users\\Owner\\freshwax', encoding: 'utf8', stdio: 'pipe' }
      );
      console.log(`✓ Migrated ${playlist.userId}`);

      // Clean up temp file
      fs.unlinkSync(tempFile);
    } catch (error) {
      console.error(`✗ Failed to migrate ${playlist.userId}:`, error.message);
    }
  }

  console.log('\nMigration complete!');
}

main().catch(console.error);
