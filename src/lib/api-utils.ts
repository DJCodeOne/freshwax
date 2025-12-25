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

// ============================================
// ADMIN KEY VALIDATION
// ============================================

/**
 * Validate admin key from request
 * Checks both body and Authorization header
 */
export function validateAdminKey(
  request: Request,
  body: { adminKey?: string } | null,
  env: { ADMIN_KEY?: string }
): boolean {
  const expectedKey = env?.ADMIN_KEY;
  if (!expectedKey) return false;

  // Check body first
  if (body?.adminKey === expectedKey) return true;

  // Check Authorization header
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === expectedKey) return true;
  }

  return false;
}

/**
 * Extract admin key from various sources
 */
export function getAdminKey(
  request: Request,
  body?: { adminKey?: string } | null
): string | null {
  // Check body
  if (body?.adminKey) return body.adminKey;

  // Check Authorization header
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check query params (for GET requests)
  const url = new URL(request.url);
  const queryKey = url.searchParams.get('adminKey');
  if (queryKey) return queryKey;

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
// CORS HELPERS
// ============================================

// Allowed origins for CORS (must match middleware.ts)
const ALLOWED_ORIGINS = [
  'https://freshwax.co.uk',
  'https://www.freshwax.co.uk',
  'https://freshwax.pages.dev',
  'https://stream.freshwax.co.uk',
  'https://icecast.freshwax.co.uk',
  'http://localhost:4321',
  'http://localhost:3000',
  'http://127.0.0.1:4321',
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin.endsWith('.freshwax.pages.dev')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function getCorsHeadersForOrigin(origin: string | null): Record<string, string> {
  if (isAllowedOrigin(origin)) {
    return {
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Allow-Credentials': 'true',
    };
  }
  return {};
}

/**
 * Handle CORS preflight request
 */
export function corsPreflightResponse(request?: Request): Response {
  const origin = request?.headers.get('origin') || null;
  const corsHeaders = getCorsHeadersForOrigin(origin);

  if (Object.keys(corsHeaders).length > 0) {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }
  return new Response(null, { status: 403 });
}

/**
 * Add CORS headers to existing headers
 */
export function withCors(headers: Record<string, string> = {}, request?: Request): Record<string, string> {
  const origin = request?.headers.get('origin') || null;
  const corsHeaders = getCorsHeadersForOrigin(origin);
  return { ...headers, ...corsHeaders };
}
