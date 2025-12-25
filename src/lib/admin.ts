// src/lib/admin.ts
// Shared admin utilities for API routes
import { getDocument } from './firebase-rest';
import { ApiErrors } from './api-utils';
import type { APIContext } from 'astro';

// Hardcoded admin UIDs for verification
export const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];
export const ADMIN_EMAILS = ['freshwaxonline@gmail.com'];

// Get admin key from environment
export function getAdminKey(locals: any): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}

// Verify admin key
export function verifyAdminKey(key: string, locals: any): boolean {
  const expectedKey = getAdminKey(locals);
  if (!expectedKey) return false;
  return key === expectedKey;
}

/**
 * Centralized admin authentication check
 * Validates admin key from request body, Authorization header, or X-Admin-Key header
 * SECURITY: Query params are NOT supported to prevent keys appearing in logs
 * Returns error response if auth fails, null if auth succeeds
 */
export function requireAdminAuth(request: Request, locals: any, bodyData?: any): Response | null {
  const expectedKey = getAdminKey(locals);
  if (!expectedKey) {
    return ApiErrors.serverError('Admin key not configured');
  }

  // Check body (for POST requests)
  if (bodyData?.adminKey === expectedKey) {
    return null; // Auth successful
  }

  // Check Authorization header (preferred method)
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === expectedKey) {
      return null; // Auth successful
    }
  }

  // Check X-Admin-Key header (alternative for GET requests)
  const adminKeyHeader = request.headers.get('X-Admin-Key');
  if (adminKeyHeader === expectedKey) {
    return null; // Auth successful
  }

  return ApiErrors.unauthorized('Invalid or missing admin credentials');
}

// Check if user is admin by UID
export async function isAdmin(uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;

  try {
    // Check admins collection
    const adminDoc = await getDocument('admins', uid);
    if (adminDoc) return true;

    // Check if user has admin role
    const userDoc = await getDocument('users', uid);
    if (userDoc?.isAdmin || userDoc?.roles?.admin) return true;
  } catch (e) {
    // Ignore errors, return false
  }

  return false;
}

// Check if email is admin
export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

// Standardized API response helpers
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export function successResponse<T>(data: T, message?: string): Response {
  const body: ApiResponse<T> = { success: true, data };
  if (message) body.message = message;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function errorResponse(error: string, status: number = 400): Response {
  return new Response(JSON.stringify({
    success: false,
    error
  }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function unauthorizedResponse(message: string = 'Unauthorized'): Response {
  return errorResponse(message, 401);
}

export function forbiddenResponse(message: string = 'Forbidden'): Response {
  return errorResponse(message, 403);
}

export function notFoundResponse(message: string = 'Not found'): Response {
  return errorResponse(message, 404);
}

export function serverErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error('[API Error]', error);
  return errorResponse(message, 500);
}

// Rate limiting helper (simple in-memory, per-worker)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  key: string,
  maxRequests: number = 100,
  windowMs: number = 60000
): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetIn: windowMs };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetIn: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, resetIn: entry.resetAt - now };
}

// Audit logging helper
export interface AuditLogEntry {
  action: string;
  adminId: string;
  adminEmail?: string;
  targetId?: string;
  targetType?: string;
  details?: any;
  ip?: string;
  userAgent?: string;
  timestamp: string;
}

// Store audit logs in memory for now (should be persisted to Firestore)
const auditLogs: AuditLogEntry[] = [];

export function logAdminAction(
  action: string,
  adminId: string,
  details?: any,
  request?: Request
): void {
  const entry: AuditLogEntry = {
    action,
    adminId,
    details,
    ip: request?.headers.get('cf-connecting-ip') || undefined,
    userAgent: request?.headers.get('user-agent') || undefined,
    timestamp: new Date().toISOString()
  };

  auditLogs.push(entry);

  // Keep only last 1000 entries in memory
  if (auditLogs.length > 1000) {
    auditLogs.shift();
  }

  console.log('[AUDIT]', JSON.stringify(entry));
}

export function getRecentAuditLogs(limit: number = 100): AuditLogEntry[] {
  return auditLogs.slice(-limit).reverse();
}
