// src/lib/relay-stations.ts
// Hardcoded approved relay stations - no Firebase reads needed
// Admin adds new stations by editing this file

export interface RelayStation {
  id: string;
  name: string;
  streamUrl: string;
  websiteUrl: string;
  logoUrl: string;
  genre: string;
  description: string;
  checkUrl?: string; // URL to check if station is live
}

export const APPROVED_RELAY_STATIONS: RelayStation[] = [
  {
    id: 'underground-lair',
    name: 'The Underground Lair',
    streamUrl: 'https://stream.rcast.net/2745',
    websiteUrl: 'https://www.theundergroundlair.fr',
    logoUrl: '/images/relay/underground-lair.png',
    genre: 'Jungle / D&B / Breakcore',
    description: 'Underground Music Webradio - Jungle, DnB, Breakcore, Hip-Hop, Dub',
    checkUrl: 'https://meta.rcast.net/2745'
  },
  {
    id: 'somafm-groovesalad',
    name: 'SomaFM Groove Salad',
    streamUrl: 'https://ice1.somafm.com/groovesalad-128-mp3',
    websiteUrl: 'https://somafm.com/groovesalad/',
    logoUrl: '/images/relay/somafm.png',
    genre: 'Electronic / Ambient',
    description: '24/7 ambient/downtempo - test station for relay'
  }
  // Add more stations here as needed
];

// Check if a station is currently live
export async function checkStationLive(station: RelayStation): Promise<{ isLive: boolean; nowPlaying?: string }> {
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
    // rcast.net returns "Artist - Title" format
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
