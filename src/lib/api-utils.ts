// src/lib/api-utils.ts
// Shared utilities for API endpoints

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
  const isProd = typeof process !== 'undefined'
    ? process.env.NODE_ENV === 'production'
    : false;

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
 */
export function errorResponse(
  message: string,
  status: number = 500,
  options?: ApiResponseOptions
): Response {
  return jsonResponse({ error: message }, status, options);
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
  } catch {
    return null;
  }
}

/**
 * Get runtime environment from Astro locals
 */
export function getEnv(locals: unknown): Record<string, string | undefined> {
  const typedLocals = locals as { runtime?: { env?: Record<string, string> } };
  return typedLocals?.runtime?.env ?? {};
}

// ============================================
// HTML ESCAPING
// ============================================

// Re-export from standalone module (safe for both server and client imports)
export { escapeHtml } from './escape-html';

