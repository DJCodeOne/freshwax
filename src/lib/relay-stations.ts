// src/lib/relay-stations.ts
// Hardcoded approved relay stations - no Firebase reads needed
// Admin adds new stations by editing this file

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
}

export const APPROVED_RELAY_STATIONS: RelayStation[] = [
  {
    id: 'underground-lair',
    name: 'The Underground Lair',
    streamUrl: 'http://95.217.34.48:8340/stream3',
    httpsStreamUrl: 'https://stream.freshwax.co.uk/live/freshwax-main/index.m3u8',
    websiteUrl: 'https://www.theundergroundlair.fr',
    logoUrl: '/place-holder.webp',
    genre: 'Jungle / D&B / Breakcore',
    description: 'Underground Music Webradio - Jungle, DnB, Breakcore, Hip-Hop, Dub',
    checkUrl: 'https://cressida.shoutca.st:2199/rpc/theundergroundlair/streaminfo.get'
  },
  // Add more stations here as needed
];

// Check if a station is currently live
export async function checkStationLive(station: RelayStation): Promise<{ isLive: boolean; nowPlaying?: string; listeners?: number }> {
  if (!station.checkUrl) {
    return { isLive: true }; // Assume live if no check URL
  }

  try {
    const response = await fetch(station.checkUrl, {
      signal: AbortSignal.timeout(5000)
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
          return {
            isLive,
            nowPlaying: isLive ? data.song : undefined,
            listeners: data.listeners
          };
        }
      } catch {
        // Not valid JSON, fall through to text parsing
      }
    }

    // rcast.net returns "Artist - Title" format (fallback)
    const nowPlaying = text.trim();
    const isLive = nowPlaying && nowPlaying !== 'Unknown - Track';

    return { isLive, nowPlaying: isLive ? nowPlaying : undefined };
  } catch {
    return { isLive: false };
  }
}

// Get station by ID
export function getStationById(id: string): RelayStation | undefined {
  return APPROVED_RELAY_STATIONS.find(s => s.id === id);
}

// Get the playback URL for a station (prefers HTTPS for browser compatibility)
export function getPlaybackUrl(station: RelayStation): { url: string; isHttps: boolean; needsRelay: boolean } {
  // If we have an HTTPS relay URL, use it
  if (station.httpsStreamUrl) {
    return { url: station.httpsStreamUrl, isHttps: true, needsRelay: false };
  }

  // If the primary stream is already HTTPS, use it directly
  if (station.streamUrl.startsWith('https://')) {
    return { url: station.streamUrl, isHttps: true, needsRelay: false };
  }

  // HTTP stream with no HTTPS relay - cannot play on HTTPS pages
  return { url: station.streamUrl, isHttps: false, needsRelay: true };
}
