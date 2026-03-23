// src/lib/api-utils.ts
// Shared utilities for API endpoints

import { TIMEOUTS } from './timeouts';

// ============================================
// LOGGER - Controlled logging for API endpoints
// ============================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerConfig {
  enabled: boolean;
  level: LogLevel;
  prefix: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Create a scoped logger for an API endpoint
 * Logs are disabled in production unless explicitly enabled
 */
export function createLogger(prefix: string, config?: Partial<LoggerConfig>) {
  const isProd = (typeof import.meta !== 'undefined' && import.meta.env?.PROD === true)
    || (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production');

  const settings: LoggerConfig = {
    enabled: config?.enabled ?? !isProd,
    level: config?.level ?? (isProd ? 'error' : 'debug'),
    prefix: config?.prefix ?? prefix,
  };

  const shouldLog = (level: LogLevel): boolean => {
    if (!settings.enabled && level !== 'error') return false;
    return LOG_LEVELS[level] >= LOG_LEVELS[settings.level];
  };

  const formatMessage = (level: LogLevel, message: string): string => {
    return `[${settings.prefix}] ${message}`;
  };

  return {
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.debug(formatMessage('debug', message), ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog('info')) {
        console.info(formatMessage('info', message), ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', message), ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      // Errors always log
      console.error(formatMessage('error', message), ...args);
    },
  };
}

// ============================================
// PII HELPERS
// ============================================

/**
 * Mask an email address for safe logging (PII protection).
 * "user@example.com" → "us***@example.com"
 */
export function maskEmail(email: unknown): string {
  if (!email || typeof email !== 'string') return '[no-email]';
  const atIndex = email.indexOf('@');
  if (atIndex < 1) return '***';
  const localPart = email.substring(0, atIndex);
  const domain = email.substring(atIndex);
  const visible = Math.min(localPart.length, 2);
  return localPart.substring(0, visible) + '***' + domain;
}

// ============================================
// API RESPONSE HELPERS
// ============================================

interface ApiResponseOptions {
  headers?: Record<string, string>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Create a successful JSON response
 */
export function jsonResponse<T>(data: T, status: number = 200, options?: ApiResponseOptions): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...options?.headers },
  });
}

/**
 * Create a success response with standard format
 */
export function successResponse<T extends Record<string, unknown>>(
  data: T,
  status: number = 200,
  options?: ApiResponseOptions
): Response {
  return jsonResponse({ success: true, ...data }, status, options);
}

/**
 * Create an error response with standard format
 * Returns { success: false, error: "message" }
 */
export function errorResponse(
  message: string,
  status: number = 500,
  options?: ApiResponseOptions
): Response {
  return jsonResponse({ success: false as const, error: message }, status, options);
}

/**
 * Standard error responses for common cases
 */
export const ApiErrors = {
  badRequest: (message: string = 'Bad request') => errorResponse(message, 400),
  unauthorized: (message: string = 'Unauthorized') => errorResponse(message, 401),
  forbidden: (message: string = 'Forbidden') => errorResponse(message, 403),
  notFound: (message: string = 'Not found') => errorResponse(message, 404),
  methodNotAllowed: (message: string = 'Method not allowed') => errorResponse(message, 405),
  conflict: (message: string = 'Conflict') => errorResponse(message, 409),
  unprocessable: (message: string = 'Unprocessable entity') => errorResponse(message, 422),
  tooManyRequests: (message: string = 'Too many requests') => errorResponse(message, 429),
  serverError: (message: string = 'Internal server error') => errorResponse(message, 500),
  notConfigured: (service: string) => errorResponse(`${service} not configured`, 500),
};

/**
 * Timing-safe string comparison to prevent timing attacks
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return result === 0;
}

/**
 * Extract admin key from various sources
 * SECURITY: Query params are NOT supported to prevent keys appearing in logs
 */
export function getAdminKey(
  request: Request,
  body?: { adminKey?: string } | null
): string | null {
  // Check body (for POST requests)
  if (body?.adminKey) return body.adminKey;

  // Check Authorization header (preferred method)
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check X-Admin-Key header (alternative for GET requests)
  const adminKeyHeader = request.headers.get('X-Admin-Key');
  if (adminKeyHeader) return adminKeyHeader;

  return null;
}

// ============================================
// REQUEST HELPERS
// ============================================

/**
 * Safely parse JSON body from request
 */
export async function parseJsonBody<T = unknown>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (_e: unknown) {
    /* intentional: malformed JSON body returns null to caller */
    return null;
  }
}

// ============================================
// R2 CONFIGURATION
// ============================================

/**
 * Get R2 configuration from Cloudflare runtime env.
 * Returns all possible R2 config fields — consumers use only what they need.
 */
export function getR2Config(env: Record<string, unknown>) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: env?.R2_BUCKET_NAME || env?.R2_RELEASES_BUCKET || import.meta.env.R2_BUCKET_NAME || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    uploadsBucket: env?.R2_UPLOADS_BUCKET || import.meta.env.R2_UPLOADS_BUCKET || 'freshwax-uploads',
    publicUrl: env?.R2_PUBLIC_URL || import.meta.env.R2_PUBLIC_URL || 'https://pub-5c0458d0721c4946884a203f2ca66ee0.r2.dev',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

// ============================================
// HTML ESCAPING
// ============================================

// Re-export from standalone module (safe for both server and client imports)
export { escapeHtml } from './escape-html';

// ============================================
// FETCH WITH TIMEOUT
// ============================================

/**
 * Fetch with an automatic timeout via AbortController.
 * Prevents external API calls from hanging indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = TIMEOUTS.API
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

