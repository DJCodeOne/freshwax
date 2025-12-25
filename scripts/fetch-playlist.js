// Script to fetch YouTube playlist and output video URLs
const playlistId = 'PLUEZ0bliZydPwv-rCpu7kUKCPG-EsGANd';

async function fetchPlaylist() {
  // Use YouTube Data API (Firebase API key won't work, need YouTube API key)
  // For now, output the expected format - user can provide video IDs manually

  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.log('No YOUTUBE_API_KEY found. Please provide video IDs manually.');
    console.log('Playlist URL: https://www.youtube.com/playlist?list=' + playlistId);
    return;
  }

  let allVideos = [];
  let nextPageToken = '';

  try {
    do {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}&key=${apiKey}${nextPageToken ? '&pageToken=' + nextPageToken : ''}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.error) {
        console.error('API Error:', data.error.message);
        break;
      }

      if (data.items) {
        for (const item of data.items) {
          const videoId = item.contentDetails.videoId;
          const title = item.snippet.title;
          const thumbnail = item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url;

          allVideos.push({
            id: videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            platform: 'youtube',
            embedId: videoId,
            title: title,
            thumbnail: thumbnail,
            playedAt: new Date().toISOString()
          });
        }
      }

      nextPageToken = data.nextPageToken || '';
    } while (nextPageToken);

    console.log('Found', allVideos.length, 'videos');
    console.log(JSON.stringify(allVideos, null, 2));
  } catch (error) {
    console.error('Error fetching playlist:', error.message);
  }
}

fetchPlaylist();
