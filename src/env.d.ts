/// <reference types="astro/client" />

// ---------------------------------------------------------------------------
// import.meta.env — Astro / Vite environment variables
// Variables prefixed with PUBLIC_ are exposed to client-side code.
// All others are server-only and available during SSR.
// ---------------------------------------------------------------------------

interface ImportMetaEnv {
  // ---- Astro built-ins ----
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly SITE: string;

  // ---- Firebase (server-side) ----
  readonly FIREBASE_PROJECT_ID: string;
  readonly FIREBASE_API_KEY: string;
  readonly FIREBASE_CLIENT_EMAIL: string;
  readonly FIREBASE_PRIVATE_KEY: string;
  readonly FIREBASE_SERVICE_ACCOUNT: string;
  readonly FIREBASE_SERVICE_ACCOUNT_KEY: string;

  // ---- Firebase (client-side, PUBLIC_) ----
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  readonly PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;

  // ---- Cloudflare R2 Storage ----
  readonly R2_ACCOUNT_ID: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly R2_PUBLIC_DOMAIN: string;
  readonly R2_PUBLIC_URL: string;
  readonly R2_BUCKET: string;
  readonly R2_BUCKET_NAME: string;
  readonly R2_UPLOADS_BUCKET: string;
  readonly R2_RELEASES_BUCKET: string;

  // ---- Cloudflare ----
  readonly CLOUDFLARE_ACCOUNT_ID: string;

  // ---- Stripe ----
  readonly STRIPE_SECRET_KEY: string;
  readonly STRIPE_PUBLISHABLE_KEY: string;
  readonly STRIPE_PLUS_ANNUAL_PRICE_ID: string;
  readonly STRIPE_PLUS_ANNUAL_PROMO_PRICE_ID: string;
  readonly STRIPE_WEBHOOK_SECRET: string;
  readonly STRIPE_CONNECT_WEBHOOK_SECRET: string;

  // ---- PayPal ----
  readonly PAYPAL_CLIENT_ID: string;
  readonly PAYPAL_CLIENT_SECRET: string;
  readonly PAYPAL_SECRET: string;
  readonly PAYPAL_MODE: string;
  readonly PAYPAL_SANDBOX: string;
  readonly PUBLIC_PAYPAL_CLIENT_ID: string;

  // ---- Pusher ----
  readonly PUSHER_APP_ID: string;
  readonly PUSHER_SECRET: string;
  readonly PUSHER_KEY: string;
  readonly PUSHER_CLUSTER: string;
  readonly PUBLIC_PUSHER_KEY: string;
  readonly PUBLIC_PUSHER_CLUSTER: string;

  // ---- Email (Resend) ----
  readonly RESEND_API_KEY: string;
  readonly ADMIN_EMAIL: string;
  readonly VINYL_STOCKIST_EMAIL: string;

  // ---- GIF / Media APIs ----
  readonly PUBLIC_GIPHY_API_KEY: string;
  readonly PUBLIC_TENOR_API_KEY: string;
  readonly YOUTUBE_API_KEY: string;

  // ---- reCAPTCHA ----
  readonly PUBLIC_RECAPTCHA_SITE_KEY: string;

  // ---- Admin & Security ----
  readonly ADMIN_KEY: string;
  readonly ADMIN_UIDS: string;
  readonly ADMIN_EMAILS: string;
  readonly CRON_SECRET: string;
  readonly GIFTCARD_SYSTEM_KEY: string;

  // ---- Livestream (Red5) ----
  readonly RED5_RTMP_URL: string;
  readonly RED5_HLS_URL: string;
  readonly RED5_SIGNING_SECRET: string;
  readonly RED5_WEBHOOK_SECRET: string;

  // ---- Livestream (WHIP / Browser Streaming) ----
  readonly WHIP_BASE_URL: string;

  // ---- Playlist Server ----
  readonly PLAYLIST_ACCESS_TOKEN: string;

  // ---- Audio Processing ----
  readonly AUDIO_PROCESSOR_URL: string;

  // ---- Vinyl API ----
  readonly PUBLIC_VINYL_API_URL: string;

  // ---- Analytics (GA4) ----
  readonly PUBLIC_GA4_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers runtime environment
// Includes KV, D1, R2 bindings and secrets/env vars set in wrangler.toml
// or Cloudflare dashboard.
// ---------------------------------------------------------------------------

type D1Database = import("@cloudflare/workers-types").D1Database;
type KVNamespace = import("@cloudflare/workers-types").KVNamespace;
type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
type ExecutionContext = import("@cloudflare/workers-types").ExecutionContext;

interface CloudflareEnv {
  // ---- Cloudflare Bindings ----
  /** D1 database binding (wrangler.toml: binding = "DB") */
  DB: D1Database;
  /** KV namespace binding (wrangler.toml: binding = "CACHE") */
  CACHE: KVNamespace;
  /** Alias used in some health-check code */
  KV: KVNamespace;
  /** KV namespace for Astro session driver (wrangler.toml: binding = "SESSION") */
  SESSION: KVNamespace;
  /** R2 bucket binding (used in health checks) */
  R2: R2Bucket;
  /** R2 bucket binding alias */
  BUCKET: R2Bucket;

  // ---- Firebase (server-side) ----
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  FIREBASE_SERVICE_ACCOUNT_KEY: string;

  // ---- Firebase (client-side, PUBLIC_) ----
  PUBLIC_FIREBASE_PROJECT_ID: string;
  PUBLIC_FIREBASE_API_KEY: string;
  PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  PUBLIC_FIREBASE_APP_ID: string;

  // ---- R2 API credentials (S3-compatible) ----
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PUBLIC_DOMAIN: string;
  R2_PUBLIC_URL: string;
  R2_BUCKET: string;
  R2_BUCKET_NAME: string;
  R2_UPLOADS_BUCKET: string;
  R2_RELEASES_BUCKET: string;

  // ---- Cloudflare ----
  CLOUDFLARE_ACCOUNT_ID: string;

  // ---- Stripe ----
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_CONNECT_WEBHOOK_SECRET: string;
  STRIPE_PLUS_ANNUAL_PRICE_ID: string;
  STRIPE_PLUS_ANNUAL_PROMO_PRICE_ID: string;

  // ---- PayPal ----
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_SECRET: string;
  PAYPAL_MODE: string;
  PAYPAL_SANDBOX: string;
  PUBLIC_PAYPAL_CLIENT_ID: string;

  // ---- Pusher ----
  PUSHER_APP_ID: string;
  PUSHER_SECRET: string;
  PUSHER_KEY: string;
  PUSHER_CLUSTER: string;
  PUBLIC_PUSHER_KEY: string;
  PUBLIC_PUSHER_CLUSTER: string;

  // ---- Email (Resend) ----
  RESEND_API_KEY: string;
  ADMIN_EMAIL: string;
  VINYL_STOCKIST_EMAIL: string;

  // ---- GIF / Media APIs ----
  PUBLIC_GIPHY_API_KEY: string;
  PUBLIC_TENOR_API_KEY: string;
  YOUTUBE_API_KEY: string;

  // ---- reCAPTCHA ----
  PUBLIC_RECAPTCHA_SITE_KEY: string;

  // ---- Admin & Security ----
  ADMIN_KEY: string;
  ADMIN_UIDS: string;
  ADMIN_EMAILS: string;
  CRON_SECRET: string;
  GIFTCARD_SYSTEM_KEY: string;

  // ---- Livestream (Red5) ----
  RED5_RTMP_URL: string;
  RED5_HLS_URL: string;
  RED5_SIGNING_SECRET: string;
  RED5_WEBHOOK_SECRET: string;
  WHIP_BASE_URL: string;

  // ---- Playlist Server ----
  PLAYLIST_ACCESS_TOKEN: string;

  // ---- Audio Processing ----
  AUDIO_PROCESSOR_URL: string;

  // ---- Vinyl API ----
  PUBLIC_VINYL_API_URL: string;

  // ---- Google Analytics ----
  PUBLIC_GA4_MEASUREMENT_ID: string;
  PUBLIC_GA4_ID: string;
}

// ---------------------------------------------------------------------------
// Cloudflare runtime — the shape of `locals.runtime`
// ---------------------------------------------------------------------------

interface CfProperties {
  [key: string]: unknown;
}

interface CloudflareRuntime {
  env: CloudflareEnv;
  cf: CfProperties;
  ctx: ExecutionContext;
}

// ---------------------------------------------------------------------------
// App.Locals — extends Astro's locals with Cloudflare runtime and nonce
// ---------------------------------------------------------------------------

declare namespace App {
  interface Locals {
    /** Cloudflare Pages runtime bindings and context */
    runtime: CloudflareRuntime;
    /** CSP nonce generated per-request in middleware */
    nonce: string;
    /** CSRF token for double-submit cookie pattern (set in middleware) */
    csrfToken: string;
  }
}

// ---------------------------------------------------------------------------
// Pusher CDN global — loaded from <script src="https://js.pusher.com/...">
// Minimal interface matching the Pusher.js constructor and channel API
// ---------------------------------------------------------------------------

interface PusherChannel {
  bind(event: string, callback: (data: unknown) => void): this;
  unbind(event: string, callback?: (data: unknown) => void): this;
  unbind_all(): this;
  readonly name: string;
  readonly members?: {
    count: number;
    each(callback: (member: { id: string; info: Record<string, unknown> }) => void): void;
    get(userId: string): { id: string; info: Record<string, unknown> } | null;
    me: { id: string; info: Record<string, unknown> };
  };
}

interface PusherInstance {
  subscribe(channelName: string): PusherChannel;
  unsubscribe(channelName: string): void;
  disconnect(): void;
}

interface PusherConstructor {
  new(key: string, options?: {
    cluster?: string;
    forceTLS?: boolean;
    authEndpoint?: string;
    auth?: {
      headers?: Record<string, string>;
    };
    channelAuthorization?: {
      endpoint?: string;
      transport?: string;
      headers?: Record<string, string>;
    };
    [key: string]: unknown;
  }): PusherInstance;
}

// ---------------------------------------------------------------------------
// JSZip — minimal interface for CDN-loaded JSZip library
// ---------------------------------------------------------------------------

interface JSZipFile {
  name: string;
  dir: boolean;
  async(type: string): Promise<unknown>;
}

interface JSZipFolder {
  file(name: string, data: unknown, options?: Record<string, unknown>): JSZipFolder;
}

interface JSZipInstance {
  file(name: string, data: unknown, options?: Record<string, unknown>): JSZipInstance;
  folder(name: string): JSZipFolder | null;
  generateAsync(options: Record<string, unknown>, onUpdate?: (metadata: unknown) => void): Promise<Blob>;
  loadAsync(data: unknown): Promise<JSZipInstance>;
  files: Record<string, JSZipFile>;
}

// ---------------------------------------------------------------------------
// Third-party CDN global APIs — eliminates @ts-ignore in embed-player.ts
// ---------------------------------------------------------------------------

/** YouTube IFrame Player API (loaded via https://www.youtube.com/iframe_api) */
declare const YT: {
  Player: new (
    elementId: string,
    config: {
      height?: string;
      width?: string;
      videoId?: string;
      playerVars?: Record<string, unknown>;
      events?: Record<string, (event: { data: number }) => void>;
    }
  ) => {
    destroy: () => void;
    playVideo: () => void;
    pauseVideo: () => void;
    seekTo: (seconds: number, allowSeekAhead: boolean) => void;
    setVolume: (volume: number) => void;
    getCurrentTime: () => number;
    getDuration: () => number;
    getPlayerState: () => number;
    getVideoData: () => { title?: string } | undefined;
  };
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
    UNSTARTED: number;
  };
};

/** Vimeo Player SDK (loaded via https://player.vimeo.com/api/player.js) */
declare const Vimeo: {
  Player: new (
    element: HTMLIFrameElement
  ) => {
    destroy: () => Promise<void>;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    setCurrentTime: (seconds: number) => Promise<void>;
    setVolume: (volume: number) => Promise<void>;
    getCurrentTime: () => Promise<number>;
    getDuration: () => Promise<number>;
    on: (event: string, callback: (...args: unknown[]) => void) => void;
  };
};

/** SoundCloud Widget API (loaded via https://w.soundcloud.com/player/api.js) */
declare const SC: {
  Widget: {
    (iframe: HTMLIFrameElement): {
      play: () => void;
      pause: () => void;
      seekTo: (ms: number) => void;
      setVolume: (volume: number) => void;
      getPosition: (callback: (position: number) => void) => void;
      getDuration: (callback: (duration: number) => void) => void;
      bind: (event: unknown, callback: (...args: unknown[]) => void) => void;
      unbind: (event: unknown) => void;
    };
    Events: {
      READY: string;
      FINISH: string;
      ERROR: string;
      PLAY: string;
      PAUSE: string;
    };
  };
};

/** HLS.js (loaded via CDN or bundled) */
declare const Hls: {
  isSupported: () => boolean;
  Events: {
    MANIFEST_PARSED: string;
    ERROR: string;
    [key: string]: string;
  };
  new (config?: Record<string, unknown>): {
    loadSource: (url: string) => void;
    attachMedia: (media: HTMLMediaElement) => void;
    on: (event: string, callback: (...args: unknown[]) => void) => void;
    destroy: () => void;
  };
};

// ---------------------------------------------------------------------------
// Window augmentation — eliminates `(window as any)` casts across the codebase
// ---------------------------------------------------------------------------

interface FreshwaxUserInfo {
  loggedIn?: boolean;
  id?: string | null;
  name?: string;
  displayName?: string;
  email?: string;
  avatar?: string | null;
}

declare global {
  interface Window {
    // ---- Streaming / playlist state ----
    isLiveStreamActive?: boolean;
    streamDetectedThisSession?: boolean;
    currentStreamData?: Record<string, unknown>;
    playlistManager?: import('./lib/playlist-manager').PlaylistManager | null;
    loadPlaylistModule?: (options?: { silent?: boolean }) => Promise<void>;
    playlistChatSetup?: boolean;
    emojiAnimationsEnabled?: boolean;
    userHasCloudSync?: boolean;
    currentUserInfo?: FreshwaxUserInfo;

    // ---- Pusher ----
    PUSHER_CONFIG?: { key: string; cluster: string };
    pusherInstance?: PusherInstance | null;
    livestreamPusher?: PusherInstance | null;
    Pusher: PusherConstructor;

    // ---- Chat ----
    setChatEnabled?: (enabled: boolean) => void;
    setupChat?: (channel: string) => void;

    // ---- Admin ----
    showToast?: (message: string, type?: string) => void;
    goPage?: (page: number) => void;

    // ---- Third-party ----
    JSZip?: new () => JSZipInstance;
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;

    // ---- Schedule modal ----
    _scheduleModalAC?: AbortController;
    openPublicSchedule?: () => void;
    openBookingSchedule?: (userId: string, displayName: string) => void;
    closeScheduleModal?: () => void;
    schedule_publicSchedule?: { refresh: () => void };
    schedule_bookingSchedule?: { refresh: () => void; setUser: (userId: string, displayName: string) => void };

    // ---- Firebase auth (legacy) ----
    firebaseAuth?: { currentUser?: { getIdToken: () => Promise<string> } };
    firebase?: { auth?: () => { currentUser?: { getIdToken: () => Promise<string> } } };

    // ---- YouTube IFrame API callback ----
    onYouTubeIframeAPIReady?: () => void;
  }
}
