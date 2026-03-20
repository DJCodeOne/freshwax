// Fresh Wax Service Worker
// Provides offline support, caching, and PWA features

const CACHE_VERSION = 35;
const STATIC_CACHE = `freshwax-static-v${CACHE_VERSION}`;
const DYNAMIC_CACHE = `freshwax-dynamic-v${CACHE_VERSION}`;
const KNOWN_CACHES = [STATIC_CACHE, DYNAMIC_CACHE];

// Max entries in the dynamic cache to prevent unbounded growth
const DYNAMIC_CACHE_LIMIT = 200;

// Critical assets to pre-cache during install
const PRECACHE_ASSETS = [
  '/offline.html',
  '/favicon.ico',
  '/logo.webp',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest'
];

// Domains that must never be cached
const EXCLUDED_DOMAINS = [
  'stripe.com',
  'js.stripe.com',
  'paypal.com',
  'paypalobjects.com',
  'firebase.googleapis.com',
  'firebaseio.com',
  'firestore.googleapis.com',
  'googleapis.com',
  'pusher.com',
  'google-analytics.com',
  'googletagmanager.com',
  'cloudflareinsights.com'
];

// --- Install: pre-cache critical assets ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(async (cache) => {
        // Cache each asset individually so one failure doesn't block the rest
        for (const asset of PRECACHE_ASSETS) {
          try {
            await cache.add(asset);
          } catch (err) {
            if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') {
              console.warn('[SW] Failed to pre-cache:', asset);
            }
          }
        }
      })
      .then(() => self.skipWaiting())
  );
});

// --- Activate: clean up old caches, claim clients ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !KNOWN_CACHES.includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// --- Fetch: routing strategies ---
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip Range requests (audio/video streaming)
  if (request.headers.get('range')) return;

  // Skip API routes -- never cache
  if (url.pathname.startsWith('/api/')) return;

  // Skip cross-origin requests to excluded domains
  if (url.origin !== self.location.origin) {
    if (EXCLUDED_DOMAINS.some((d) => url.hostname.includes(d))) return;
    // Also skip any other cross-origin request we don't control
    return;
  }

  // --- HTML pages: network-first, cache fallback, offline fallback ---
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  // --- Hashed Astro bundles (_astro/*): cache-first (immutable) ---
  if (url.pathname.startsWith('/_astro/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // --- Other static assets: cache-first ---
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else: let the browser handle normally
});

// --- Strategy: network-first for HTML with offline fallback ---
async function networkFirstHTML(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(stripCacheBustParams(request), response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match('/offline.html');
  }
}

// --- Strategy: cache-first with network fallback ---
async function cacheFirst(request) {
  const cacheKey = stripCacheBustParams(request);
  const cached = await caches.match(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(cacheKey, response.clone());
      trimCache(DYNAMIC_CACHE, DYNAMIC_CACHE_LIMIT);
    }
    return response;
  } catch {
    // Static asset unavailable offline -- return nothing
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// --- Helpers ---

// Strip cache-bust query params (?v=, ?t=) so assets cache under their canonical URL
function stripCacheBustParams(request) {
  const url = new URL(request.url);
  let changed = false;
  for (const key of ['v', 't']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    return new Request(url.toString(), { headers: request.headers, mode: request.mode, credentials: request.credentials });
  }
  return request;
}

function isStaticAsset(pathname) {
  return /\.(js|css|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|eot|avif)$/i.test(pathname);
}

// Trim oldest entries from a cache when it exceeds maxItems
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    // Delete oldest entries (first in list)
    for (let i = 0; i < keys.length - maxItems; i++) {
      await cache.delete(keys[i]);
    }
  }
}

// --- Push notifications ---
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body || 'New notification from Fresh Wax',
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-32x32.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' }
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Fresh Wax', options)
  );
});

// --- Notification click ---
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
