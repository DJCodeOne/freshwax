# Fresh Wax Live Streaming System

## Overview

The Fresh Wax Live Streaming platform enables approved DJs to broadcast live audio/video streams to listeners. The system supports:
- **Red5 RTMP Server** (self-hosted) - Video and high-quality audio streaming
- **IceCast** - Audio-only streaming via BUTT
- **Twitch** - Restream from Twitch

## Red5 Server Setup (Self-Hosted)

### Server Requirements
- Java 11 or higher
- 4GB+ RAM recommended
- Stable upload bandwidth (10+ Mbps for HD streaming)
- Public IP or dynamic DNS

### Installing Red5

1. **Download Red5 Server:**
   ```bash
   wget https://github.com/Red5/red5-server/releases/download/v1.3.0/red5-server-1.3.0.tar.gz
   tar -xzf red5-server-1.3.0.tar.gz
   cd red5-server
   ```

2. **Configure Red5:**
   Edit `conf/red5.properties`:
   ```properties
   rtmp.host=0.0.0.0
   rtmp.port=1935
   http.host=0.0.0.0
   http.port=5080
   ```

3. **Enable HLS Output:**
   Edit `webapps/live/WEB-INF/red5-web.xml` to enable HLS transcoding.

4. **Start Red5:**
   ```bash
   ./red5.sh
   ```

### Network Configuration

**Port Forwarding (Router):**
| Port | Protocol | Purpose |
|------|----------|---------|
| 1935 | TCP | RTMP ingest |
| 5080 | TCP | HTTP/HLS output |
| 8443 | TCP | HTTPS (optional) |

**Firewall Rules:**
```bash
sudo ufw allow 1935/tcp  # RTMP
sudo ufw allow 5080/tcp  # HTTP
sudo ufw allow 8443/tcp  # HTTPS
```

### SSL/HTTPS Setup (Recommended)

For secure streaming, set up nginx as a reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name stream.freshwax.co.uk;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # HLS streaming
    location /hls/ {
        proxy_pass http://localhost:5080/live/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        
        # CORS headers
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods 'GET, OPTIONS';
        add_header Access-Control-Allow-Headers 'Origin, Content-Type, Accept';
    }
}
```

### Dynamic DNS (Optional)

If you don't have a static IP, use a dynamic DNS service:
- No-IP
- DuckDNS
- Cloudflare Tunnel

## Features

### For Viewers
- **Live Stream Page** (`/live`) - Watch/listen to live streams
- **HLS Video Player** - Adaptive bitrate streaming
- **Real-time Chat** - Chat with emojis and Giphy GIFs (login required)
- **Reactions** - Like streams and rate them 1-5 stars (login required)
- **Viewer Counts** - See how many people are watching
- **Stream Duration** - Track how long the DJ has been live

### For DJs
- **Go Live Dashboard** (`/account/go-live`) - Start/stop streams
- **Red5 RTMP Streaming** - Connect via OBS/Streamlabs
- **Audio Streaming** - Connect via BUTT/IceCast
- **Twitch Restream** - Embed Twitch streams
- **Stream Key Generation** - Secure streaming credentials
- **Stream History** - View past stream statistics

### Header Integration
- **LIVE Button** - Grey when offline, red when someone is live
- **Real-time Updates** - Checks every 30 seconds for live status
- **DJ Name Display** - Shows who's currently streaming

## Technical Architecture

### Red5 Configuration in Code

Update `src/lib/livestream.ts` with your server details:

```typescript
export const RED5_CONFIG = {
  // Your server address
  serverHost: 'stream.freshwax.co.uk', // or your IP
  
  // RTMP port (default 1935)
  rtmpPort: 1935,
  
  // Application name
  rtmpApp: 'live',
  
  // HLS port
  hlsPort: 5080,
  
  // Functions for URL generation
  getRtmpServerUrl: function() {
    return `rtmp://${this.serverHost}:${this.rtmpPort}/${this.rtmpApp}`;
  },
  
  getHlsPlaybackUrl: function(streamKey) {
    return `https://${this.serverHost}/hls/${streamKey}/index.m3u8`;
  }
};
```

### Database Collections

#### `livestreams`
```javascript
{
  id: string,
  djId: string,                    // Firebase UID
  djName: string,
  djAvatar: string | null,
  title: string,
  description: string,
  genre: string,
  
  streamType: 'red5' | 'audio' | 'twitch',
  streamSource: 'red5' | 'icecast' | 'twitch',
  audioStreamUrl: string | null,   // IceCast stream URL
  videoStreamUrl: string | null,   // RTMP URL
  hlsUrl: string | null,           // HLS playback URL
  twitchChannel: string | null,    // Twitch channel name
  streamKey: string,               // Private key for DJ
  
  status: 'offline' | 'live' | 'scheduled',
  isLive: boolean,
  startedAt: ISO string,
  endedAt: ISO string | null,
  scheduledFor: ISO string | null,
  
  peakViewers: number,
  currentViewers: number,
  totalViews: number,
  totalLikes: number,
  averageRating: number,
  ratingCount: number,
  
  coverImage: string | null,
  createdAt: ISO string,
  updatedAt: ISO string
}
```

#### `livestream-chat`
```javascript
{
  id: string,
  streamId: string,
  userId: string,
  userName: string,
  userAvatar: string | null,
  message: string,
  type: 'text' | 'emoji' | 'giphy',
  giphyUrl: string | null,
  giphyId: string | null,
  isModerated: boolean,
  createdAt: ISO string
}
```

#### `livestream-reactions`
```javascript
{
  id: string,
  streamId: string,
  userId: string,
  type: 'like' | 'rating',
  rating: number | null,          // 1-5 for ratings
  createdAt: ISO string
}
```

#### `livestream-viewers`
```javascript
{
  id: string,
  streamId: string,
  userId: string | null,          // null for anonymous
  sessionId: string,
  joinedAt: ISO string,
  leftAt: ISO string | null,
  isActive: boolean,
  lastHeartbeat: ISO string
}
```

## API Endpoints

### GET `/api/livestream/status`
Check if any stream is currently live.

**Query Parameters:**
- `streamId` (optional) - Get specific stream details

**Response:**
```json
{
  "success": true,
  "isLive": true,
  "streams": [...],
  "primaryStream": {...},
  "scheduled": [...]
}
```

### POST `/api/livestream/manage`
Manage stream lifecycle.

**Actions:**

**Start Stream:**
```json
{
  "action": "start",
  "djId": "uid",
  "djName": "DJ Name",
  "title": "Stream Title",
  "description": "...",
  "genre": "Jungle / D&B",
  "streamType": "audio",
  "audioStreamUrl": "..."
}
```

**Stop Stream:**
```json
{
  "action": "stop",
  "djId": "uid",
  "streamId": "stream-id"
}
```

**Update Stream:**
```json
{
  "action": "update",
  "djId": "uid",
  "streamId": "stream-id",
  "title": "New Title"
}
```

**Schedule Stream:**
```json
{
  "action": "schedule",
  "djId": "uid",
  "title": "Upcoming Stream",
  "scheduledFor": "2024-12-25T20:00:00Z"
}
```

### GET/POST `/api/livestream/chat`

**GET - Fetch messages:**
```
GET /api/livestream/chat?streamId=xxx&limit=50
```

**POST - Send message:**
```json
{
  "streamId": "xxx",
  "userId": "uid",
  "userName": "User Name",
  "message": "Hello!",
  "type": "text"
}
```

**POST - Send GIF:**
```json
{
  "streamId": "xxx",
  "userId": "uid",
  "userName": "User Name",
  "message": "[GIF]",
  "type": "giphy",
  "giphyUrl": "https://...",
  "giphyId": "abc123"
}
```

### POST `/api/livestream/react`

**Like/Unlike:**
```json
{
  "action": "like",
  "streamId": "xxx",
  "userId": "uid"
}
```

**Rate:**
```json
{
  "action": "rate",
  "streamId": "xxx",
  "userId": "uid",
  "rating": 5
}
```

**Join as Viewer:**
```json
{
  "action": "join",
  "streamId": "xxx",
  "userId": "uid",
  "sessionId": "session_xxx"
}
```

**Leave:**
```json
{
  "action": "leave",
  "streamId": "xxx",
  "sessionId": "session_xxx"
}
```

**Heartbeat:**
```json
{
  "action": "heartbeat",
  "streamId": "xxx",
  "sessionId": "session_xxx"
}
```

## File Structure

```
src/
├── lib/
│   └── livestream.ts           # Types and utilities
├── pages/
│   ├── live.astro              # Viewer page
│   ├── account/
│   │   └── go-live.astro       # DJ dashboard
│   └── api/
│       └── livestream/
│           ├── status.ts       # Check live status
│           ├── manage.ts       # Start/stop/update streams
│           ├── chat.ts         # Chat messages
│           └── react.ts        # Likes, ratings, viewers
public/
└── live-stream.js              # Client-side viewer logic
```

## Red5 RTMP Streaming Setup (OBS)

### OBS Studio Configuration

1. Open OBS Studio
2. Go to **Settings → Stream**
3. Set Service to **"Custom..."**
4. Enter:
   - **Server:** `rtmp://stream.freshwax.co.uk:1935/live`
   - **Stream Key:** Your generated key from the dashboard
5. Go to **Settings → Output → Streaming**
6. Recommended settings:
   - Video Bitrate: 2500-4000 kbps
   - Audio Bitrate: 160-320 kbps
   - Encoder: x264 or NVENC
   - Keyframe Interval: 2 seconds
7. Go to **Settings → Video**
   - Base Resolution: 1920x1080
   - Output Resolution: 1280x720 or 1920x1080
   - FPS: 30
8. Click **"Start Streaming"**

### Supported Software
- OBS Studio (Recommended)
- Streamlabs Desktop
- XSplit
- vMix
- Wirecast
- FFmpeg (command line)

### FFmpeg Command Example
```bash
ffmpeg -re -i input.mp4 \
  -c:v libx264 -preset veryfast -b:v 3000k \
  -c:a aac -b:a 160k \
  -f flv rtmp://stream.freshwax.co.uk:1935/live/YOUR_STREAM_KEY
```

## Audio Streaming Setup (BUTT/IceCast)

### Server Configuration
- **Server Type:** IceCast
- **Address:** stream.freshwax.co.uk
- **Port:** 8000
- **Mount Point:** /live
- **Format:** MP3
- **Bitrate:** 128kbps or higher

### DJ Instructions
1. Download BUTT from https://danielnoethen.de/butt/
2. Go to Settings → Main → Add Server
3. Enter the server details above
4. Use the stream key from the Go Live dashboard as password
5. Click Play to start streaming

## Video Streaming Setup (Twitch)

1. Start your Twitch stream normally
2. Enter your Twitch channel name in the Go Live dashboard
3. The stream will be embedded on Fresh Wax
4. Chat will work through Fresh Wax's native chat system

## Giphy Integration

The chat system supports Giphy GIFs. To enable:

1. Add your Giphy API key to `.env`:
   ```
   GIPHY_API_KEY=your_api_key_here
   ```

2. Get a free API key from https://developers.giphy.com/

## Security

- Only approved DJs can go live
- Stream keys are unique per session
- Chat messages are rate-limited (1 per second)
- Basic content moderation blocks spam/links
- Reactions require authentication
- Viewer sessions track anonymous and logged-in users

## Real-time Features

### Chat
- Uses Firestore real-time listeners
- Messages appear instantly for all viewers
- Supports emoji picker and Giphy search

### Viewer Count
- Heartbeat every 30 seconds
- Viewers marked inactive after leaving
- Peak viewer tracking

### LIVE Button
- Header checks status every 30 seconds
- Turns red with pulse animation when live
- Shows DJ name on hover/mobile

## Future Enhancements

- [ ] OBS/RTMP direct streaming support
- [ ] Stream recording/VOD
- [ ] Scheduled stream reminders
- [ ] Chat moderation tools for DJs
- [ ] Audio visualizer from actual audio
- [ ] Multiple simultaneous streams
- [ ] Stream overlay/branding options
- [ ] Tip/donation system integration
