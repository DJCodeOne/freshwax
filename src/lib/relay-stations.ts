// src/lib/relay-stations.ts
// Hardcoded approved relay stations - no Firebase reads needed
// Admin adds new stations by editing this file

import { TIMEOUTS } from './timeouts';

export interface RelayStation {
  id: string;
  name: string;
  streamUrl: string;        // Primary stream URL (can be HTTP)
  httpsStreamUrl?: string;  // HTTPS relay URL for browser playback (required for HTTP streams)
  websiteUrl: string;
  logoUrl: string;
  genre: string;
  description: string;
  checkUrl?: string;        // URL to check if station is live
  twitchChannel?: string;   // If the station ALSO streams video on Twitch, /live
                            // embeds that player (video+audio in sync) instead of
                            // the audio relay + placeholder. Just the channel name.
}

export const APPROVED_RELAY_STATIONS: RelayStation[] = [
  {
    id: 'underground-lair',
    name: 'The Underground Lair',
    streamUrl: 'https://relay.freshwax.co.uk/underground-lair',
    httpsStreamUrl: 'https://relay.freshwax.co.uk/underground-lair',
    websiteUrl: 'https://www.theundergroundlair.fr',
    logoUrl: '/place-holder.webp',
    genre: 'Jungle / D&B / Breakcore',
    description: 'Underground Music Webradio - Jungle, DnB, Breakcore, Hip-Hop, Dub',
    checkUrl: 'https://cressida.shoutca.st:2199/rpc/theundergroundlair/streaminfo.get',
    twitchChannel: 'theundergroundlair23'
  },
];

// Check if a station is currently live
export interface StationStatus {
  isLive: boolean;
  nowPlaying?: string;
  listeners?: number;
  serverTitle?: string; // Current show/DJ name from the station
}

// Is the station's Twitch channel ACTUALLY broadcasting right now? /live must
// only embed the Twitch player when it is — an offline embed is a black,
// silent player while the audio relay sits unused (bit us Jul 12: UL relaying
// audio-only, their Twitch offline).
//
// HTML scraping does NOT work from Workers: Twitch serves Cloudflare egress
// the bare JS shell with no JSON-LD for live AND offline channels alike
// (verified Jul 12 via /api/livestream/twitch-live-check against a 24/7
// channel). Use Twitch's public web GQL endpoint instead — the same
// unauthenticated Client-ID the twitch.tv web player ships (stable for
// years, used by countless tools). If Twitch ever rotates it this returns
// false and /live falls back to the audio relay + placeholder — safe.
export async function checkTwitchLive(channel: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_]{2,30}$/.test(channel)) return false;
  try {
    const response = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: `query { user(login: "${channel}") { stream { id } } }` }),
      signal: AbortSignal.timeout(TIMEOUTS.SHORT),
    });
    if (!response.ok) return false;
    const data = await response.json() as { data?: { user?: { stream?: { id?: string } | null } | null } };
    return Boolean(data?.data?.user?.stream?.id);
  } catch (_e: unknown) {
    return false;
  }
}

export async function checkStationLive(station: RelayStation): Promise<StationStatus> {
  if (!station.checkUrl) {
    return { isLive: true }; // Assume live if no check URL
  }

  try {
    const response = await fetch(station.checkUrl, {
      signal: AbortSignal.timeout(TIMEOUTS.SHORT)
    });

    if (!response.ok) {
      return { isLive: false };
    }

    const text = await response.text();

    // Try parsing as Shoutcast JSON (cressida.shoutca.st format)
    if (station.checkUrl.includes('shoutca.st') || station.checkUrl.includes('streaminfo.get')) {
      try {
        const json = JSON.parse(text);
        if (json.type === 'result' && json.data && json.data[0]) {
          const data = json.data[0];
          const isLive = data.server === 'Online' && data.sourcestate === true;
          // Strip "UNKNOWN - " prefix from song title (Shoutcast sends this when no artist is set)
          let songTitle = data.song;
          if (songTitle && typeof songTitle === 'string') {
            songTitle = songTitle.replace(/^UNKNOWN\s*-\s*/i, '').trim() || songTitle;
          }
          return {
            isLive,
            nowPlaying: isLive ? songTitle : undefined,
            listeners: data.listeners,
            serverTitle: data.servertitle || data.title || undefined
          };
        }
      } catch (_e: unknown) {
        // non-critical: not valid JSON, fall through to text parsing
      }
    }

    // rcast.net returns "Artist - Title" format (fallback)
    const nowPlaying = text.trim();
    const isLive = nowPlaying && nowPlaying !== 'Unknown - Track';

    return { isLive, nowPlaying: isLive ? nowPlaying : undefined };
  } catch (_e: unknown) {
    // non-critical: relay status check failed — assume offline
    return { isLive: false };
  }
}

