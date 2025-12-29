// src/lib/rate-limit.ts
// Rate limiting and safeguards for API endpoints

interface RateLimitConfig {
  maxRequests: number;      // Max requests allowed in window
  windowMs: number;         // Time window in milliseconds
  blockDurationMs?: number; // How long to block after limit exceeded (default: windowMs)
}

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  blocked?: boolean;
  blockedUntil?: number;
}

// In-memory store (works for single instance, resets on deploy)
// For production edge deployment, this provides per-isolate limiting
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically (prevent memory leak)
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute
let lastCleanup = Date.now();

function cleanupOldEntries() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;

  lastCleanup = now;
  for (const [key, entry] of rateLimitStore.entries()) {
    // Remove entries older than 1 hour
    if (now - entry.firstRequest > 60 * 60 * 1000) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Check rate limit for a given key (e.g., IP address, user ID, endpoint)
 * Returns { allowed: true } if within limits, or { allowed: false, retryAfter } if blocked
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): { allowed: boolean; retryAfter?: number; remaining?: number } {
  cleanupOldEntries();

  const now = Date.now();
  const entry = rateLimitStore.get(key);

  // Check if currently blocked
  if (entry?.blocked && entry.blockedUntil && now < entry.blockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.blockedUntil - now) / 1000)
    };
  }

  // No existing entry or window expired - create new
  if (!entry || (now - entry.firstRequest) >= config.windowMs) {
    rateLimitStore.set(key, {
      count: 1,
      firstRequest: now,
      blocked: false
    });
    return { allowed: true, remaining: config.maxRequests - 1 };
  }

  // Within window - check count
  if (entry.count >= config.maxRequests) {
    // Block for the specified duration
    const blockDuration = config.blockDurationMs || config.windowMs;
    entry.blocked = true;
    entry.blockedUntil = now + blockDuration;
    rateLimitStore.set(key, entry);

    return {
      allowed: false,
      retryAfter: Math.ceil(blockDuration / 1000)
    };
  }

  // Increment count
  entry.count++;
  rateLimitStore.set(key, entry);

  return { allowed: true, remaining: config.maxRequests - entry.count };
}

/**
 * Reset rate limit for a key (e.g., after successful auth)
 */
export function resetRateLimit(key: string): void {
  rateLimitStore.delete(key);
}

/**
 * Pre-configured rate limiters for common use cases
 */
export const RateLimiters = {
  // Admin bulk operations: 5 per minute, block for 5 minutes if exceeded
  adminBulk: {
    maxRequests: 5,
    windowMs: 60 * 1000,
    blockDurationMs: 5 * 60 * 1000
  },

  // Standard API: 60 requests per minute
  standard: {
    maxRequests: 60,
    windowMs: 60 * 1000
  },

  // Auth attempts: 10 per 15 minutes, block for 30 minutes
  auth: {
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
    blockDurationMs: 30 * 60 * 1000
  },

  // Chat messages: 30 per minute
  chat: {
    maxRequests: 30,
    windowMs: 60 * 1000
  },

  // Uploads: 10 per hour
  upload: {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000
  },

  // Destructive operations: 3 per hour
  destructive: {
    maxRequests: 3,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 60 * 60 * 1000
  },

  // Admin delete operations: 20 per hour (admin key protected)
  adminDelete: {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 10 * 60 * 1000  // 10 minute block if exceeded
  }
};

/**
 * Batch operation safeguards
 */
export interface BatchConfig {
  maxItems: number;           // Max items per batch
  maxTotalPerHour?: number;   // Max total items processed per hour
  delayBetweenMs?: number;    // Delay between items (prevents overwhelming)
}

const batchCountStore = new Map<string, { count: number; resetAt: number }>();

/**
 * Check if a batch operation is within limits
 */
export function checkBatchLimit(
  key: string,
  itemCount: number,
  config: BatchConfig
): { allowed: boolean; error?: string; maxAllowed?: number } {
  // Check per-batch limit
  if (itemCount > config.maxItems) {
    return {
      allowed: false,
      error: `Batch size ${itemCount} exceeds maximum of ${config.maxItems}`,
      maxAllowed: config.maxItems
    };
  }

  // Check hourly total if configured
  if (config.maxTotalPerHour) {
    const now = Date.now();
    const entry = batchCountStore.get(key);

    // Reset if hour has passed
    if (!entry || now >= entry.resetAt) {
      batchCountStore.set(key, {
        count: itemCount,
        resetAt: now + 60 * 60 * 1000
      });
      return { allowed: true };
    }

    // Check if adding this batch would exceed hourly limit
    if (entry.count + itemCount > config.maxTotalPerHour) {
      const remaining = config.maxTotalPerHour - entry.count;
      return {
        allowed: false,
        error: `Hourly limit reached. ${remaining} items remaining this hour.`,
        maxAllowed: remaining > 0 ? remaining : 0
      };
    }

    // Update count
    entry.count += itemCount;
    batchCountStore.set(key, entry);
  }

  return { allowed: true };
}

/**
 * Pre-configured batch limiters
 */
export const BatchLimiters = {
  // Chat cleanup: max 500 per batch, 2000 per hour
  chatCleanup: {
    maxItems: 500,
    maxTotalPerHour: 2000,
    delayBetweenMs: 50
  },

  // Bulk delete: max 100 per batch, 500 per hour
  bulkDelete: {
    maxItems: 100,
    maxTotalPerHour: 500,
    delayBetweenMs: 100
  },

  // Data export: max 1000 per batch
  export: {
    maxItems: 1000
  }
};

/**
 * Helper to get client identifier for rate limiting
 */
export function getClientId(request: Request): string {
  // Try CF-Connecting-IP first (Cloudflare)
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  // Try X-Forwarded-For
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();

  // Try X-Real-IP
  const realIp = request.headers.get('X-Real-IP');
  if (realIp) return realIp;

  // Fallback to a hash of user agent + accept headers (not ideal but better than nothing)
  const ua = request.headers.get('User-Agent') || '';
  const accept = request.headers.get('Accept') || '';
  return `anon-${simpleHash(ua + accept)}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Create a rate-limited Response for blocked requests
 */
export function rateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({
    success: false,
    error: 'Rate limit exceeded. Please try again later.',
    retryAfter
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': retryAfter.toString()
    }
  });
}

/**
 * Async delay helper for batch operations
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
