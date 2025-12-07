# Fresh Wax - Red5 Pro Livestream Integration

## Overview

This document explains how to configure Red5 Pro streaming server to work with the Fresh Wax livestream system.

## Architecture

```
┌─────────────────┐     RTMP      ┌─────────────────┐     HLS      ┌─────────────────┐
│   DJ (OBS)      │ ────────────► │   Red5 Pro      │ ───────────► │   Viewers       │
│                 │               │   Server        │              │   (live.astro)  │
└─────────────────┘               └────────┬────────┘              └─────────────────┘
                                           │
                                           │ Webhooks
                                           ▼
                                  ┌─────────────────┐
                                  │   Fresh Wax     │
                                  │   API Server    │
                                  └─────────────────┘
```

## Red5 Server Configuration

### 1. Environment Variables

Add these to your `.env` file:

```env
# Red5 Server URLs
RED5_RTMP_URL=rtmp://stream.freshwax.co.uk/live
RED5_HLS_URL=https://stream.freshwax.co.uk/live
RED5_WS_URL=wss://stream.freshwax.co.uk/ws
RED5_API_URL=https://stream.freshwax.co.uk/api

# Security
RED5_API_KEY=your-red5-api-key
RED5_SIGNING_SECRET=your-signing-secret-min-32-chars
RED5_WEBHOOK_SECRET=your-webhook-secret-min-32-chars
```

### 2. Red5 Application Configuration

In your Red5 Pro server configuration, set up the `live` application:

**red5-web.xml:**
```xml
<bean id="web.handler" class="com.red5pro.server.stream.Red5ProWebScope">
    <property name="scope" ref="web.scope" />
    <property name="name" value="live" />
    
    <!-- Stream authentication -->
    <property name="streamAuthService">
        <bean class="com.freshwax.auth.StreamAuthService">
            <property name="validationUrl" value="https://freshwax.co.uk/api/livestream/validate-stream" />
        </bean>
    </property>
</bean>
```

### 3. Webhook Configuration

Configure Red5 to send webhooks to Fresh Wax on stream events:

**Webhook URL:** `https://freshwax.co.uk/api/livestream/red5-webhook`

**Events to send:**
- `publish` - When a stream starts
- `unpublish` - When a stream ends
- `viewer_join` - When a viewer connects (optional)
- `viewer_leave` - When a viewer disconnects (optional)

**Webhook payload format:**
```json
{
  "event": "publish",
  "streamKey": "fwx_abc12345_def67890_xyz123_sig456",
  "timestamp": "2024-01-15T14:30:00Z",
  "clientIp": "192.168.1.1",
  "metadata": {
    "codec": "h264",
    "bitrate": 2500
  }
}
```

**Security:** Add header `x-red5-signature` with HMAC-SHA256 of the payload body.

### 4. Stream Authentication

Configure Red5 to validate stream keys before allowing publish:

**Validation endpoint:** `GET https://freshwax.co.uk/api/livestream/validate-stream?key={streamKey}`

**Response format:**
```json
// Success (allow stream)
{
  "valid": true,
  "slotId": "slot-id-123",
  "djId": "dj-id-456",
  "djName": "DJ Fresh",
  "hlsUrl": "https://stream.freshwax.co.uk/live/fwx_.../index.m3u8"
}

// Failure (reject stream)
{
  "valid": false,
  "reason": "Stream key not yet valid. Try again in 5 minutes."
}
```

## Stream Key Format

Stream keys are generated with a specific format for security and traceability:

```
fwx_{djIdShort}_{slotIdShort}_{timestamp}_{signature}

Example: fwx_abc12345_def67890_m2k3n4p_a1b2c3d4e5f6
```

- `fwx` - Prefix for identification
- `djIdShort` - First 8 chars of DJ's user ID
- `slotIdShort` - First 8 chars of booking slot ID
- `timestamp` - Base36 encoded slot start time
- `signature` - HMAC signature (12 chars) for validation

### Validity Window

Stream keys are valid from 30 minutes before the slot start time until 5 minutes after the scheduled end time.

## API Endpoints

### 1. Validate Stream Key
```
GET /api/livestream/validate-stream?key={streamKey}
```
Called by Red5 before allowing a publish.

### 2. Red5 Webhook Handler
```
POST /api/livestream/red5-webhook
```
Receives events from Red5 server.

### 3. Stream Status
```
GET /api/livestream/status
```
Returns current live streams and scheduled streams.

### 4. Manage Slots
```
POST /api/livestream/slots
```
Book, cancel, and manage DJ slots.

## HLS Playback

The live page uses HLS.js for playback. HLS URLs follow this pattern:

```
https://stream.freshwax.co.uk/live/{streamKey}/index.m3u8
```

Alternative paths:
- `/live/{streamKey}/playlist.m3u8`
- `/live/{streamKey}/chunklist.m3u8` (low latency)

## Testing

### 1. Test Webhook Endpoint
```bash
curl -X GET https://freshwax.co.uk/api/livestream/red5-webhook
```

### 2. Test Stream Validation
```bash
curl "https://freshwax.co.uk/api/livestream/validate-stream?key=fwx_test123_slot456_abc_sig"
```

### 3. Simulate Publish Event
```bash
curl -X POST https://freshwax.co.uk/api/livestream/red5-webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"publish","streamKey":"your-stream-key","timestamp":"2024-01-15T14:30:00Z"}'
```

## Recommended OBS Settings

For DJs streaming to Fresh Wax:

**Stream Settings:**
- Server: `rtmp://stream.freshwax.co.uk/live`
- Stream Key: (provided in DJ Lobby)

**Output Settings (1080p @ good connection):**
- Video Bitrate: 4500 kbps
- Audio Bitrate: 256 kbps (320 for audio-focused)
- Encoder: x264 or NVENC
- Keyframe Interval: 2 seconds

**Output Settings (720p @ average connection):**
- Video Bitrate: 2500 kbps
- Audio Bitrate: 192 kbps
- Keyframe Interval: 2 seconds

**Output Settings (480p @ poor connection):**
- Video Bitrate: 1000 kbps
- Audio Bitrate: 128 kbps
- Keyframe Interval: 2 seconds

## Troubleshooting

### Stream Not Starting
1. Check stream key validity window
2. Verify DJ has an approved booking
3. Check Red5 server logs
4. Ensure webhook URL is accessible

### Playback Issues
1. Check HLS URL is correct
2. Verify CORS headers on Red5 server
3. Check browser console for HLS.js errors
4. Try alternative HLS paths

### Stream Disconnecting
1. Check DJ's upload speed
2. Reduce bitrate settings
3. Check server capacity
4. Review Red5 logs for errors

## Security Notes

1. Never expose `RED5_SIGNING_SECRET` or `RED5_WEBHOOK_SECRET`
2. Stream keys are single-use per booking slot
3. Keys expire after the slot end time + grace period
4. All webhook payloads should be signature-verified in production
