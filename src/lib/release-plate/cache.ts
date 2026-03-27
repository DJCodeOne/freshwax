/**
 * Release plate cache — unified localStorage cache with TTL.
 */
import { TIMEOUTS } from '../timeouts';
import { AUTH_CACHE_TTL } from '../constants/limits';

export const FWCache = {
  PREFIX: 'fwx_',
  TTL: {
    RATINGS: 30 * 60 * 1000,      // 30 minutes
    COMMENTS: 10 * 60 * 1000,     // 10 minutes
    USER_RATING: 120 * 60 * 1000, // 2 hours
    OWNERSHIP: 60 * 60 * 1000     // 1 hour
  },

  get: function(key: string): unknown {
    try {
      const cached = localStorage.getItem(this.PREFIX + key);
      if (!cached) return null;
      const data = JSON.parse(cached);
      const ttl = data.ttl || this.TTL.RATINGS;
      if (Date.now() - data.ts > ttl) {
        localStorage.removeItem(this.PREFIX + key);
        return null;
      }
      return data.v;
    } catch (e: unknown) { return null; }
  },

  set: function(key: string, value: unknown, ttl?: number): void {
    try {
      localStorage.setItem(this.PREFIX + key, JSON.stringify({
        v: value,
        ts: Date.now(),
        ttl: ttl || this.TTL.RATINGS
      }));
    } catch (e: unknown) {
      this.cleanup();
    }
  },

  update: function<T>(key: string, updateFn: (current: T) => T): T {
    const current = (this.get(key) || {}) as T;
    const updated = updateFn(current);
    this.set(key, updated);
    return updated;
  },

  remove: function(key: string): void {
    try { localStorage.removeItem(this.PREFIX + key); } catch (e: unknown) { /* intentional: localStorage may throw in Safari private browsing */ }
  },

  cleanup: function(): void {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(this.PREFIX)) {
          const cached = localStorage.getItem(key);
          if (cached) {
            const data = JSON.parse(cached);
            if (Date.now() - data.ts > (data.ttl || this.TTL.RATINGS)) {
              keysToRemove.push(key);
            }
          }
        }
      }
      keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
    } catch (e: unknown) { /* intentional: localStorage cleanup is best-effort */ }
  }
};

/**
 * Auth helper — wait for auth to be ready.
 */
export async function getAuthUser(): Promise<{ uid: string; displayName?: string | null } | null> {
  // Check sessionStorage cache first for instant auth
  try {
    const cached = sessionStorage.getItem('fw_auth_cache');
    if (cached) {
      const cachedAuth = JSON.parse(cached);
      if (cachedAuth && cachedAuth.id && cachedAuth.timestamp) {
        if (Date.now() - cachedAuth.timestamp < AUTH_CACHE_TTL) {
          return { uid: cachedAuth.id, displayName: cachedAuth.displayName || cachedAuth.name };
        }
      }
    }
  } catch (e: unknown) { /* ignore cache errors */ }

  // If authReady promise exists (from Header), wait for it with timeout
  if (window.authReady) {
    try {
      await Promise.race([
        window.authReady,
        new Promise((_, reject) => setTimeout(() => reject('timeout'), TIMEOUTS.TOAST))
      ]);
    } catch (e: unknown) {
      // Timeout - check cache again or Firebase directly
    }
  }
  return window.firebaseAuth?.currentUser || window.authUser || null;
}

/**
 * Helper functions — comment sanitization and date formatting.
 */
export function sanitizeComment(text: string): string {
  return text
    .replace(/https?:\/\/[^\s]+/gi, '[link removed]')
    .replace(/www\.[^\s]+/gi, '[link removed]')
    .replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/gi, '[email removed]')
    .replace(/<[^>]*>/g, '')
    .trim()
    .substring(0, 300);
}

export function formatDate(timestamp: number | string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + 'm ago';
  if (hours < 24) return hours + 'h ago';
  if (days < 7) return days + 'd ago';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
