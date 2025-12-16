// src/lib/red5.ts
// Red5 Pro Streaming Server Configuration & Utilities
// Central configuration for Fresh Wax livestream infrastructure

// Note: Using Web Crypto API compatible approach for Cloudflare Workers

// =============================================================================
// RUNTIME ENVIRONMENT SUPPORT
// =============================================================================

// Store runtime env vars for Cloudflare Pages
let runtimeEnv: Record<string, string> = {};

/**
 * Initialize Red5 config with runtime environment variables
 * Call this at the start of API routes to pass Cloudflare env vars
 */
export function initRed5Env(env: Record<string, string | undefined>): void {
  runtimeEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value) runtimeEnv[key] = value;
  }
}

// Helper to get env var from runtime or process.env
function getEnv(key: string, defaultValue: string = ''): string {
  return runtimeEnv[key] || (typeof process !== 'undefined' ? process.env?.[key] : '') || defaultValue;
}

// =============================================================================
// RED5 SERVER CONFIGURATION
// =============================================================================

// Config is a getter function to read env vars at runtime
export const RED5_CONFIG = {
  // Server endpoints - update these when configuring Red5
  get server() {
    return {
      // RTMP ingest URL for OBS/streaming software (uses rtmp subdomain, not proxied by Cloudflare)
      rtmpUrl: getEnv('RED5_RTMP_URL', 'rtmp://rtmp.freshwax.co.uk/live'),

      // HLS playback base URL
      hlsBaseUrl: getEnv('RED5_HLS_URL', 'https://stream.freshwax.co.uk/live'),

      // WebSocket URL for real-time events (optional)
      wsUrl: getEnv('RED5_WS_URL', 'wss://stream.freshwax.co.uk/ws'),

      // Admin API (for server-side stream management)
      apiUrl: getEnv('RED5_API_URL', 'https://stream.freshwax.co.uk/api'),
      apiKey: getEnv('RED5_API_KEY', ''),
    };
  },

  // Stream settings
  stream: {
    // Supported stream types
    types: ['video', 'audio'] as const,

    // Default HLS segment duration (seconds)
    hlsSegmentDuration: 4,

    // HLS playlist length (number of segments)
    hlsPlaylistLength: 3,

    // Maximum bitrate allowed (kbps)
    maxBitrate: 6000,

    // Recommended settings for different connection speeds
    qualityPresets: {
      low: { videoBitrate: 1000, audioBitrate: 128, resolution: '854x480' },
      medium: { videoBitrate: 2500, audioBitrate: 192, resolution: '1280x720' },
      high: { videoBitrate: 4500, audioBitrate: 256, resolution: '1920x1080' },
      audioOnly: { audioBitrate: 320, format: 'aac' },
    },
  },

  // Security settings
  get security() {
    return {
      // Stream key prefix for identification
      keyPrefix: 'fwx',

      // Stream key validity window (milliseconds before/after scheduled time)
      keyValidityWindow: 30 * 60 * 1000, // 30 minutes

      // Secret for HMAC signing (should be in env)
      signingSecret: getEnv('RED5_SIGNING_SECRET', 'freshwax-stream-secret-change-in-production'),

      // Webhook secret for validating Red5 callbacks
      webhookSecret: getEnv('RED5_WEBHOOK_SECRET', 'webhook-secret-change-in-production'),
    };
  },

  // Timeouts and intervals
  timing: {
    // How often to check stream health (ms)
    healthCheckInterval: 10000,

    // Stream timeout - mark offline if no data (ms)
    streamTimeout: 30000,

    // Grace period after scheduled end time (ms)
    endGracePeriod: 5 * 60 * 1000, // 5 minutes
  },
};

// =============================================================================
// STREAM KEY GENERATION
// =============================================================================

/**
 * Simple hash function for Cloudflare Workers compatibility
 * Uses a basic string hash - security comes from Firebase validation
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to hex and ensure positive
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Generate a time-based stream key for a DJ session
 *
 * Format: fwx_{djIdShort}_{slotId}_{timestamp}_{signature}
 *
 * This key is:
 * - Unique per booking/session
 * - Time-bound (validated against slot start/end times)
 * - Stored in Firebase for validation
 * - Human-readable prefix for debugging
 */
export function generateStreamKey(
  djId: string,
  slotId: string,
  startTime: Date,
  endTime: Date
): string {
  const { keyPrefix, signingSecret } = RED5_CONFIG.security;

  // Short identifiers for readability
  const djIdShort = djId.substring(0, 8);
  const slotIdShort = slotId.substring(0, 8);

  // Timestamp component (slot start time as unix timestamp)
  const timestamp = Math.floor(startTime.getTime() / 1000).toString(36);

  // Create signature from payload + secret
  const payload = `${djId}:${slotId}:${startTime.toISOString()}:${endTime.toISOString()}:${signingSecret}`;
  const signature = simpleHash(payload).substring(0, 12);

  return `${keyPrefix}_${djIdShort}_${slotIdShort}_${timestamp}_${signature}`;
}

/**
 * Validate a stream key against a slot's timing
 * Returns validation result with details
 */
export interface StreamKeyValidation {
  valid: boolean;
  reason?: string;
  slotId?: string;
  djId?: string;
  withinWindow: boolean;
  expired: boolean;
  tooEarly: boolean;
}

export function validateStreamKeyTiming(
  streamKey: string,
  slotStartTime: Date,
  slotEndTime: Date
): StreamKeyValidation {
  const now = new Date();
  const { keyValidityWindow, endGracePeriod } = RED5_CONFIG.security;
  const { timing } = RED5_CONFIG;
  
  // Parse the stream key
  const parts = streamKey.split('_');
  if (parts.length !== 5 || parts[0] !== RED5_CONFIG.security.keyPrefix) {
    return { valid: false, reason: 'Invalid key format', withinWindow: false, expired: false, tooEarly: false };
  }
  
  // Calculate validity window
  const windowStart = new Date(slotStartTime.getTime() - keyValidityWindow);
  const windowEnd = new Date(slotEndTime.getTime() + timing.endGracePeriod);
  
  const tooEarly = now < windowStart;
  const expired = now > windowEnd;
  const withinWindow = !tooEarly && !expired;
  
  if (tooEarly) {
    const minutesUntilValid = Math.ceil((windowStart.getTime() - now.getTime()) / 60000);
    return {
      valid: false,
      reason: `Stream key not yet valid. Try again in ${minutesUntilValid} minutes.`,
      withinWindow: false,
      expired: false,
      tooEarly: true,
    };
  }
  
  if (expired) {
    return {
      valid: false,
      reason: 'Stream key has expired',
      withinWindow: false,
      expired: true,
      tooEarly: false,
    };
  }
  
  return {
    valid: true,
    withinWindow: true,
    expired: false,
    tooEarly: false,
    slotId: parts[2],
    djId: parts[1],
  };
}

// =============================================================================
// URL BUILDERS
// =============================================================================

/**
 * Build the RTMP ingest URL for a stream key
 */
export function buildRtmpUrl(streamKey: string): string {
  return `${RED5_CONFIG.server.rtmpUrl}/${streamKey}`;
}

/**
 * Build the HLS playback URL for a stream key
 */
export function buildHlsUrl(streamKey: string): string {
  // Ensure /live/ path is always included (MediaMTX streams are at /live/{streamKey})
  let baseUrl = RED5_CONFIG.server.hlsBaseUrl;
  // If baseUrl doesn't end with /live, add it
  if (!baseUrl.endsWith('/live')) {
    baseUrl = baseUrl.replace(/\/$/, '') + '/live';
  }
  return `${baseUrl}/${streamKey}/index.m3u8`;
}

/**
 * Build alternative HLS URL formats (some players need different paths)
 */
export function buildHlsUrls(streamKey: string): {
  primary: string;
  fallback: string;
  lowLatency: string;
} {
  const base = RED5_CONFIG.server.hlsBaseUrl;
  return {
    primary: `${base}/${streamKey}/index.m3u8`,
    fallback: `${base}/${streamKey}/playlist.m3u8`,
    lowLatency: `${base}/${streamKey}/chunklist.m3u8`,
  };
}

// =============================================================================
// WEBHOOK SIGNATURE VERIFICATION
// =============================================================================

/**
 * Verify a webhook signature from Red5
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  const { webhookSecret } = RED5_CONFIG.security;

  // Simple signature verification using hash
  // For production with Red5 Pro, use proper HMAC verification
  const expectedSignature = simpleHash(payload + webhookSecret);

  // Simple comparison (MediaMTX doesn't send signatures by default)
  // If no signature provided, skip verification
  if (!signature) return true;

  return signature === expectedSignature;
}

// =============================================================================
// STREAM INFO TYPES
// =============================================================================

export interface Red5StreamInfo {
  streamKey: string;
  isLive: boolean;
  startedAt?: string;
  viewerCount: number;
  bitrate?: number;
  resolution?: string;
  codec?: string;
  hlsUrl: string;
  rtmpUrl: string;
}

export interface Red5WebhookEvent {
  event: 'publish' | 'unpublish' | 'record_start' | 'record_stop' | 'viewer_join' | 'viewer_leave';
  streamKey: string;
  timestamp: string;
  clientIp?: string;
  metadata?: Record<string, any>;
}

// =============================================================================
// QUALITY RECOMMENDATIONS
// =============================================================================

/**
 * Get recommended streaming settings based on upload speed
 */
export function getQualityRecommendation(uploadSpeedMbps: number): {
  recommended: keyof typeof RED5_CONFIG.stream.qualityPresets;
  settings: typeof RED5_CONFIG.stream.qualityPresets[keyof typeof RED5_CONFIG.stream.qualityPresets];
  warning?: string;
} {
  const presets = RED5_CONFIG.stream.qualityPresets;
  
  if (uploadSpeedMbps < 1) {
    return {
      recommended: 'audioOnly',
      settings: presets.audioOnly,
      warning: 'Your upload speed is very low. Audio-only streaming recommended.',
    };
  }
  
  if (uploadSpeedMbps < 3) {
    return {
      recommended: 'low',
      settings: presets.low,
      warning: 'Your upload speed is limited. 480p recommended for stable streaming.',
    };
  }
  
  if (uploadSpeedMbps < 6) {
    return {
      recommended: 'medium',
      settings: presets.medium,
    };
  }
  
  return {
    recommended: 'high',
    settings: presets.high,
  };
}

// =============================================================================
// STREAM STATUS HELPERS
// =============================================================================

export type StreamStatus = 
  | 'scheduled'    // Booked but not yet time
  | 'lobby'        // DJ is in lobby waiting
  | 'connecting'   // Stream key used, waiting for video
  | 'live'         // Active stream
  | 'ending'       // Grace period after scheduled end
  | 'completed'    // Successfully ended
  | 'failed'       // Stream failed/disconnected
  | 'cancelled';   // Cancelled by DJ

export function getStreamStatusDisplay(status: StreamStatus): {
  label: string;
  color: string;
  icon: string;
} {
  const statusMap: Record<StreamStatus, { label: string; color: string; icon: string }> = {
    scheduled: { label: 'Scheduled', color: '#6b7280', icon: '📅' },
    lobby: { label: 'In Lobby', color: '#f59e0b', icon: '🎧' },
    connecting: { label: 'Connecting...', color: '#3b82f6', icon: '🔄' },
    live: { label: 'LIVE', color: '#dc2626', icon: '🔴' },
    ending: { label: 'Ending Soon', color: '#f97316', icon: '⏰' },
    completed: { label: 'Completed', color: '#10b981', icon: '✅' },
    failed: { label: 'Disconnected', color: '#ef4444', icon: '❌' },
    cancelled: { label: 'Cancelled', color: '#6b7280', icon: '🚫' },
  };
  
  return statusMap[status] || statusMap.scheduled;
}
