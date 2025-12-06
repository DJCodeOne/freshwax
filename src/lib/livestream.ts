// src/lib/livestream.ts
// Live Streaming System - Types and utilities
// Supports Red5 RTMP server, IceCast, and Twitch

export type StreamType = 'audio' | 'video' | 'both';
export type StreamSource = 'red5' | 'icecast' | 'twitch' | 'obs' | 'custom';
export type StreamStatus = 'offline' | 'live' | 'ending' | 'scheduled';

// Red5 Server Configuration
// Update these values to match your Red5 server setup
export const RED5_CONFIG = {
  // Your home server address (update with your actual IP/domain)
  serverHost: 'stream.freshwax.co.uk',
  
  // RTMP ingest port (default Red5 port)
  rtmpPort: 1935,
  
  // RTMP application name
  rtmpApp: 'live',
  
  // HLS output port (for web playback)
  hlsPort: 5080,
  
  // HLS application path
  hlsApp: 'live',
  
  // Get RTMP publish URL for DJs
  getRtmpPublishUrl: function(streamKey: string): string {
    return `rtmp://${this.serverHost}:${this.rtmpPort}/${this.rtmpApp}/${streamKey}`;
  },
  
  // Get RTMP server URL (without stream key) for OBS/software
  getRtmpServerUrl: function(): string {
    return `rtmp://${this.serverHost}:${this.rtmpPort}/${this.rtmpApp}`;
  },
  
  // Get HLS playback URL for viewers
  getHlsPlaybackUrl: function(streamKey: string): string {
    return `https://${this.serverHost}:${this.hlsPort}/${this.hlsApp}/${streamKey}/index.m3u8`;
  },
  
  // Alternative HTTP HLS URL (if using nginx proxy)
  getHlsHttpUrl: function(streamKey: string): string {
    return `https://${this.serverHost}/hls/${streamKey}/index.m3u8`;
  },
  
  // Get FLV playback URL (for low-latency)
  getFlvPlaybackUrl: function(streamKey: string): string {
    return `https://${this.serverHost}:${this.hlsPort}/${this.rtmpApp}/${streamKey}.flv`;
  }
};

export interface LiveStream {
  id?: string;
  djId: string;
  djName: string;
  djAvatar?: string;
  title: string;
  description?: string;
  genre?: string;
  
  // Stream configuration
  streamType: StreamType;
  streamSource: StreamSource;
  
  // Audio stream (IceCast/BUTT)
  audioStreamUrl?: string;
  
  // Video stream (Twitch/OBS)
  videoStreamUrl?: string;
  twitchChannel?: string;
  
  // Status
  status: StreamStatus;
  isLive: boolean;
  startedAt?: string;
  endedAt?: string;
  scheduledFor?: string;
  
  // Stats
  peakViewers: number;
  currentViewers: number;
  totalViews: number;
  totalLikes: number;
  averageRating: number;
  ratingCount: number;
  
  // Artwork
  coverImage?: string;
  
  // Metadata
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id?: string;
  streamId: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  message: string;
  type: 'text' | 'emoji' | 'giphy';
  giphyUrl?: string;
  giphyId?: string;
  isModerated: boolean;
  createdAt: string;
}

export interface StreamReaction {
  id?: string;
  streamId: string;
  odUserId: string;
  type: 'like' | 'rating';
  rating?: number; // 1-5 stars
  createdAt: string;
}

export interface ViewerSession {
  id?: string;
  streamId: string
  odUserId?: string;
  sessionId: string;
  joinedAt: string;
  leftAt?: string;
  isActive: boolean;
}

// Stream URL helpers
export function getIceCastEmbedUrl(serverUrl: string, mountPoint: string): string {
  return `${serverUrl}/${mountPoint}`;
}

export function getTwitchEmbedUrl(channel: string, parent: string): string {
  return `https://player.twitch.tv/?channel=${channel}&parent=${parent}&muted=false`;
}

export function getTwitchChatUrl(channel: string, parent: string): string {
  return `https://www.twitch.tv/embed/${channel}/chat?parent=${parent}&darkpopout`;
}

// Format helpers
export function formatViewerCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

export function formatStreamDuration(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
  
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Default stream configuration for DJs
export function getDefaultStreamConfig(djId: string, djName: string): Partial<LiveStream> {
  return {
    djId,
    djName,
    streamType: 'audio',
    streamSource: 'icecast',
    status: 'offline',
    isLive: false,
    peakViewers: 0,
    currentViewers: 0,
    totalViews: 0,
    totalLikes: 0,
    averageRating: 0,
    ratingCount: 0
  };
}

// IceCast/BUTT/Red5 connection instructions
export const STREAM_INSTRUCTIONS = {
  red5: {
    title: 'Connect with OBS Studio (Recommended)',
    steps: [
      'Download OBS Studio from https://obsproject.com/',
      'Go to Settings → Stream',
      'Select "Custom..." as the Service',
      'Enter the Server URL shown below',
      'Enter your Stream Key (shown below)',
      'Go to Settings → Output → Streaming',
      'Set Video Bitrate: 2500-4000 kbps',
      'Set Audio Bitrate: 128-320 kbps',
      'Click "Start Streaming" when ready!'
    ],
    software: ['OBS Studio', 'Streamlabs', 'XSplit', 'vMix', 'Wirecast']
  },
  butt: {
    title: 'Connect with BUTT (Audio Only)',
    steps: [
      'Download BUTT from https://danielnoethen.de/butt/',
      'Open BUTT and go to Settings → Main',
      'Add a new server with Type: ShoutCast/IceCast',
      'For RTMP audio, use a tool like ffmpeg instead',
      'Or stream audio through OBS with no video'
    ]
  },
  icecast: {
    title: 'Connect with BUTT (Broadcast Using This Tool)',
    steps: [
      'Download BUTT from https://danielnoethen.de/butt/',
      'Open BUTT and go to Settings → Main',
      'Add a new server with these details:',
      '  - Type: IceCast',
      '  - Address: stream.freshwax.co.uk',
      '  - Port: 8000',
      '  - Password: Your stream key (shown below)',
      '  - Mount: /live',
      '  - Format: MP3 or OGG (MP3 recommended)',
      '  - Bitrate: 128kbps or higher',
      'Click the Play button to start streaming!'
    ]
  },
  twitch: {
    title: 'Stream via Twitch',
    steps: [
      'Start your Twitch stream as normal',
      'Enter your Twitch channel name below',
      'We\'ll embed your Twitch stream on Fresh Wax',
      'Your chat will be synced automatically'
    ]
  },
  ffmpeg: {
    title: 'Stream with FFmpeg (Advanced)',
    command: 'ffmpeg -re -i input.mp3 -c:a aac -b:a 128k -f flv rtmp://stream.freshwax.co.uk:1935/live/YOUR_STREAM_KEY'
  }
};

// Emoji picker categories
export const EMOJI_CATEGORIES = [
  { name: 'music', emojis: ['🎵', '🎶', '🎧', '🎤', '🎹', '🥁', '🎸', '🎺', '🎷', '🔊', '📻', '💿'] },
  { name: 'reactions', emojis: ['🔥', '❤️', '💯', '🙌', '👏', '🤘', '✨', '💥', '⚡', '🌟', '💪', '👊'] },
  { name: 'faces', emojis: ['😍', '🥰', '😎', '🤩', '🥳', '😈', '👀', '🤯', '😱', '🫠', '💀', '😂'] },
  { name: 'vibes', emojis: ['🌴', '🌙', '🌊', '🍾', '🥂', '💨', '🌈', '☀️', '🌺', '🦋', '🐍', '🦁'] }
];
