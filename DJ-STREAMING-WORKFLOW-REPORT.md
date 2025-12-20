# Fresh Wax DJ Streaming Workflow Report

**Date:** December 20, 2025
**Prepared by:** Claude Code Analysis
**Version:** Production (Cloudflare Pages)

---

## Executive Summary

This report documents the complete DJ streaming workflow for Fresh Wax, covering the entire journey from booking a slot to going live, handling takeovers, and ending streams. The system uses Firebase Firestore for data persistence, Pusher for real-time communications, and MediaMTX/Red5 for stream handling.

---

## 1. DJ Slot Booking Flow

### 1.1 Entry Points
- **Book a Slot Page:** `/dj-lobby/book`
- **DJ Lobby:** `/account/dj-lobby` (contains "Go Live" button)

### 1.2 Authentication Flow
```
User clicks "Book a Slot"
    |
    v
Check localStorage for cached auth (fw_uid, fw_displayName)
    |
    v
Firebase onAuthStateChanged verifies user
    |
    +--> If not logged in: Redirect to /login?redirect=/dj-lobby/book
    |
    +--> If logged in: Check DJ role (roles.dj === true OR user doc exists)
         |
         +--> If not DJ: Show "DJ Access Required" message
         |
         +--> If DJ: Show booking grid
```

### 1.3 Booking Process
1. **Grid Display:** 24-hour grid (8 columns x 3 rows) showing:
   - Open slots (green)
   - Booked slots (red) with DJ name
   - Your slots (blue)
   - Past slots (grayed out)

2. **Duration Options:** 1 hour or 2 hours

3. **Daily Limit:** 2 hours maximum per DJ per day

4. **Booking Form Fields:**
   - DJ Name (required, max 25 chars)
   - Stream Title (required, max 50 chars)
   - Genre/Style (optional, max 30 chars)

5. **On Submit:**
   ```javascript
   // Generate unique stream key
   const streamKey = generateStreamKey(); // fw- + 16 alphanumeric chars

   // Create booking document
   await addDoc(collection(db, 'livestream-bookings'), {
     djId: currentUser.uid,
     djName,
     streamTitle,
     genre,
     startTime: Timestamp.fromDate(startTime),
     endTime: Timestamp.fromDate(endTime),
     duration: 2,
     streamKey,
     keyActive: true,
     status: 'confirmed',
     createdAt: serverTimestamp()
   });
   ```

### 1.4 Stream Key Generation (Book Page)
**Simple Format (book.astro):**
```javascript
function generateStreamKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let key = 'fw-';
  for (let i = 0; i < 16; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key; // e.g., "fw-AbC123xYz789pQrS"
}
```

---

## 2. Stream Key Generation (Production System)

### 2.1 Secure Key Format (red5.ts)
**Format:** `fwx_{djIdShort}_{slotId}_{timestamp}_{signature}`

```javascript
export function generateStreamKey(djId, slotId, startTime, endTime) {
  const { keyPrefix, signingSecret } = RED5_CONFIG.security;

  // Short identifiers
  const djIdShort = djId.substring(0, 8);
  const slotIdShort = slotId.substring(0, 8);

  // Timestamp (base36 encoded)
  const timestamp = Math.floor(startTime.getTime() / 1000).toString(36);

  // Signature (hash of payload + secret)
  const payload = `${djId}:${slotId}:${startTime}:${endTime}:${signingSecret}`;
  const signature = simpleHash(payload).substring(0, 12);

  return `${keyPrefix}_${djIdShort}_${slotIdShort}_${timestamp}_${signature}`;
  // e.g., "fwx_Y3TGc171_m4k9xp2q_lq8n2kf_a1b2c3d4e5f6"
}
```

### 2.2 Key Validity Window
- **Before slot:** 30 minutes (configurable via `streamKeyRevealMinutes`)
- **After slot end:** 5 minutes grace period (configurable via `gracePeriodMinutes`)

### 2.3 Key Display
- Shown in "Your Stream Key" panel when DJ has upcoming booking
- Includes:
  - **RTMP URL:** `rtmp://rtmp.freshwax.co.uk/live`
  - **Stream Key:** The generated key
  - **Valid Time:** Start - End of booking

---

## 3. Go Live Process

### 3.1 Go Live Options

#### Option A: Via Booked Slot (Recommended)
1. DJ books slot via `/dj-lobby/book`
2. Stream key appears 15 minutes before slot
3. DJ configures OBS with Server URL and Stream Key
4. DJ starts streaming in OBS
5. DJ clicks "Go Live" in DJ Lobby

#### Option B: Go Live Now (Instant)
1. DJ clicks "Go Live" button in DJ Lobby
2. System checks if anyone is currently streaming
3. If clear, generates temporary stream key
4. Creates live slot until top of next hour
5. DJ starts streaming immediately

#### Option C: Early Start
1. DJ has upcoming booking within 2 hours
2. Clicks "Start Early" to extend booking to start now
3. New stream key generated for extended time window

### 3.2 Go Live API Flow
```
POST /api/livestream/slots
{
  "action": "go_live",
  "djId": "user-uid",
  "djName": "DJ Name",
  "streamKey": "fwx_...",
  "title": "Stream Title",
  "genre": "Jungle / D&B"
}
```

**Validation Steps:**
1. Check if another DJ is already live
2. Verify stream is actually active (HLS check with 2 retries)
3. Create livestreamSlots document with status: "live"
4. Record start time for usage tracking

### 3.3 Stream Validation
```javascript
// Check if stream is actually broadcasting
const hlsCheckUrl = buildHlsUrl(streamKey);
let streamActive = false;

for (let attempt = 0; attempt < 2; attempt++) {
  const checkResponse = await fetch(hlsCheckUrl, { method: 'HEAD' });
  if (checkResponse.ok) {
    streamActive = true;
    break;
  }
  await sleep(1000);
}

// If check fails, proceed anyway (DJ clicked Ready)
```

---

## 4. Takeover System

### 4.1 Takeover Purpose
Allows a DJ to request taking over the stream from the currently live DJ.

### 4.2 Takeover Flow

```
DJ A is currently LIVE
         |
DJ B clicks "Request Takeover"
         |
         v
POST /api/dj-lobby/takeover
{
  "action": "request",
  "requesterId": "dj-b-uid",
  "requesterName": "DJ B",
  "targetDjId": "dj-a-uid",
  "targetDjName": "DJ A"
}
         |
         v
Creates djTakeoverRequests document
         |
         v
Pusher event: private-dj-{dj-a-uid} -> 'takeover-request'
         |
         v
DJ A sees incoming takeover request modal
         |
    +----+----+
    |         |
 ACCEPT    DECLINE
    |         |
    v         v
Stream key    Update status
transferred   to 'declined'
to DJ B
```

### 4.3 Takeover Request Data Structure
```javascript
// Document: djTakeoverRequests/{targetDjId}
{
  requesterId: "dj-b-uid",
  requesterName: "DJ B",
  requesterAvatar: "url-or-null",
  targetDjId: "dj-a-uid",
  targetDjName: "DJ A",
  status: "pending" | "approved" | "declined",
  createdAt: "ISO timestamp"
}

// Mirror document: djTakeoverRequests/request_{requesterId}
// Same data with docType: "outgoing"
```

### 4.4 Takeover Approval
When DJ A approves:
1. Current stream key is passed to DJ B
2. DJ B receives Pusher event with credentials:
   - Server URL: `rtmp://rtmp.freshwax.co.uk/live`
   - Stream Key: Current active key
3. DJ B can now stream using those credentials
4. DJ A should stop their stream

### 4.5 Takeover Limits
- 3 requests per session
- Requests expire after 5 minutes if not responded
- Cleanup job removes expired requests

---

## 5. Stream End/Cleanup Process

### 5.1 End Stream API
```
POST /api/livestream/slots
{
  "action": "endStream",
  "slotId": "slot-id",
  "djId": "user-uid"
}
```

### 5.2 End Stream Steps
1. Verify DJ owns the stream (or is admin)
2. Update slot status to "completed"
3. Set endedAt timestamp
4. Record streaming minutes for usage tracking:
   ```javascript
   const streamMinutes = Math.ceil((endMs - startMs) / 60000);
   await setDocument('userUsage', djId, {
     streamMinutesToday: currentMinutes + streamMinutes,
     dayDate: today,
     lastStreamAt: nowISO
   });
   ```
5. Invalidate cache

### 5.3 Booking Cancellation
When a DJ cancels a booking:
```javascript
await updateDoc(doc(db, 'livestream-bookings', bookingId), {
  status: 'cancelled',
  keyActive: false,
  cancelledAt: serverTimestamp()
});
```

The stream key becomes invalid immediately.

---

## 6. Data Collections Used

### 6.1 Firestore Collections

| Collection | Purpose |
|------------|---------|
| `livestream-bookings` | Simple booking records from book.astro |
| `livestreamSlots` | Main slot management with full details |
| `djTakeoverRequests` | Takeover request tracking |
| `djLobbyPresence` | Who's online in the DJ lobby |
| `userUsage` | Stream time tracking per user |
| `system/admin-settings` | Global settings (limits, grace periods) |

### 6.2 Key Settings (from admin-settings)
```javascript
{
  defaultDailyHours: 2,        // Max hours per day
  defaultWeeklySlots: 2,       // Max slots per week
  streamKeyRevealMinutes: 15,  // When key becomes visible
  gracePeriodMinutes: 3,       // Grace period after slot ends
  sessionEndCountdown: 10,     // Countdown seconds at end
  allowGoLiveNow: true,        // Enable instant go-live
  allowGoLiveAfter: true,      // Enable "go live after" feature
  allowTakeover: true          // Enable takeover system
}
```

---

## 7. Issues & Recommendations

### 7.1 Current Issues Found

1. **Dual Stream Key Systems:**
   - `book.astro` generates simple keys: `fw-{16 chars}`
   - `slots.ts` generates secure keys: `fwx_{djId}_{slotId}_{timestamp}_{sig}`
   - These should be unified to use the secure format

2. **Collection Confusion:**
   - `livestream-bookings` (simple booking)
   - `livestreamSlots` (full slot management)
   - Consider consolidating into one collection

3. **Key Validation Gap:**
   - Simple keys from book.astro have no time-based validation
   - Only secure keys from red5.ts have validity windows

### 7.2 Recommendations

1. **Unify Stream Key Generation:**
   - Use `generateStreamKey()` from red5.ts everywhere
   - Migrate book.astro to call the API for key generation

2. **Single Booking Collection:**
   - Use `livestreamSlots` as the single source of truth
   - Update book.astro to create entries in livestreamSlots

3. **Add Stream Health Monitoring:**
   - Implement periodic checks for active streams
   - Auto-mark as disconnected if stream drops

4. **Takeover Timeout UI:**
   - Add visible countdown for takeover requests
   - Currently 5-minute timeout is server-side only

---

## 8. Technical Stack

| Component | Technology |
|-----------|------------|
| Frontend | Astro SSR |
| Hosting | Cloudflare Pages |
| Database | Firebase Firestore |
| Auth | Firebase Authentication |
| Real-time | Pusher (pub/sub) |
| Streaming | MediaMTX (RTMP -> HLS) |
| CDN | Cloudflare (for HLS) |

---

## 9. API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/livestream/slots` | GET | Get schedule, check stream key |
| `/api/livestream/slots` | POST | Book, cancel, go live, end stream |
| `/api/dj-lobby/takeover` | GET | Check takeover status |
| `/api/dj-lobby/takeover` | POST | Request/approve/decline takeover |
| `/api/dj-lobby/presence` | GET | List online DJs |
| `/api/dj-lobby/presence` | POST | Join/leave/heartbeat |

---

## 10. Conclusion

The Fresh Wax DJ streaming system provides a comprehensive workflow for DJs to book slots, generate stream keys, go live, and handle takeovers. The dual-system approach (simple booking page vs. full lobby system) creates some complexity that could be simplified by unifying the stream key generation and booking collections.

The takeover system works via Pusher real-time events and allows smooth handoffs between DJs. Stream time tracking enables enforcement of daily limits and future subscription tiers.

**Status:** System is functional and deployed. Minor consolidation recommended for maintainability.
