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
  readonly GIPHY_API_KEY: string;
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

  // ---- Playlist Server ----
  readonly PLAYLIST_ACCESS_TOKEN: string;

  // ---- Audio Processing ----
  readonly AUDIO_PROCESSOR_URL: string;

  // ---- Vinyl API ----
  readonly PUBLIC_VINYL_API_URL: string;
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

  // ---- R2 API credentials (S3-compatible) ----
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PUBLIC_DOMAIN: string;
  R2_PUBLIC_URL: string;
  R2_BUCKET_NAME: string;
  R2_UPLOADS_BUCKET: string;
  R2_RELEASES_BUCKET: string;

  // ---- Stripe ----
  STRIPE_SECRET_KEY: string;
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
  GIPHY_API_KEY: string;
  PUBLIC_GIPHY_API_KEY: string;
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

  // ---- Playlist Server ----
  PLAYLIST_ACCESS_TOKEN: string;
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
  }
}

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
    playlistChatSetup?: boolean;
    emojiAnimationsEnabled?: boolean;
    userHasCloudSync?: boolean;
    currentUserInfo?: FreshwaxUserInfo;

    // ---- Pusher ----
    PUSHER_CONFIG?: { key: string; cluster: string };
    pusherInstance?: InstanceType<typeof window.Pusher> | null;
    livestreamPusher?: InstanceType<typeof window.Pusher> | null;
    Pusher: any;

    // ---- Chat ----
    setChatEnabled?: (enabled: boolean) => void;
    setupChat?: (channel: string) => void;

    // ---- Admin ----
    showToast?: (message: string, type?: string) => void;
    goPage?: (page: number) => void;

    // ---- Third-party ----
    JSZip?: new () => any;
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;

    // ---- Firebase auth (legacy) ----
    firebaseAuth?: { currentUser?: { getIdToken: () => Promise<string> } };
    firebase?: { auth?: () => { currentUser?: { getIdToken: () => Promise<string> } } };
  }
}
