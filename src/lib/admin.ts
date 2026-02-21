// src/lib/admin.ts
// Shared admin utilities for API routes
import { getDocument } from './firebase-rest';
import { ApiErrors, timingSafeCompare } from './api-utils';
import type { APIContext } from 'astro';

// Use timingSafeCompare from api-utils (shared timing-safe string comparison)
const timingSafeEqual = timingSafeCompare;

// Admin configuration - loaded from environment variables
// Fallback to defaults only in development
let adminConfig: { uids: string[]; emails: string[] } | null = null;

function getAdminConfig(): { uids: string[]; emails: string[] } {
  if (adminConfig) return adminConfig;

  // Get from environment variables (comma-separated lists)
  const envUids = import.meta.env.ADMIN_UIDS || '';
  const envEmails = import.meta.env.ADMIN_EMAILS || '';

  // Parse comma-separated values
  const uids = envUids.split(',').map((s: string) => s.trim()).filter(Boolean);
  const emails = envEmails.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);

  adminConfig = { uids, emails };
  return adminConfig;
}

// Initialize admin config with runtime env (for Cloudflare Workers)
export function initAdminEnv(env?: { ADMIN_UIDS?: string; ADMIN_EMAILS?: string }): void {
  if (env?.ADMIN_UIDS || env?.ADMIN_EMAILS) {
    const uids = (env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const emails = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    adminConfig = { uids, emails };
  }
}

// Export getters instead of hardcoded constants
export function getAdminUids(): string[] {
  return getAdminConfig().uids;
}

export function getAdminEmails(): string[] {
  return getAdminConfig().emails;
}

// Get admin key from environment
export function getAdminKey(locals: App.Locals): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}

// Verify admin key with timing-safe comparison
export function verifyAdminKey(key: string, locals: App.Locals): boolean {
  const expectedKey = getAdminKey(locals);
  if (!expectedKey || !key) return false;
  return timingSafeEqual(key, expectedKey);
}

/**
 * Centralized admin authentication check
 * Validates admin key from request body, Authorization header, X-Admin-Key header,
 * OR a valid Firebase ID token from an admin user.
 * SECURITY: Query params are NOT supported to prevent keys appearing in logs
 * Returns error response if auth fails, null if auth succeeds
 */
export async function requireAdminAuth(request: Request, locals: App.Locals, bodyData?: Record<string, unknown>): Promise<Response | null> {
  const expectedKey = getAdminKey(locals);

  // Check body (for POST requests) - timing-safe comparison
  if (expectedKey && bodyData?.adminKey && timingSafeEqual(bodyData.adminKey, expectedKey)) {
    return null; // Auth successful via admin key in body
  }

  // Check X-Admin-Key header - timing-safe comparison
  const adminKeyHeader = request.headers.get('X-Admin-Key');
  if (expectedKey && adminKeyHeader && timingSafeEqual(adminKeyHeader, expectedKey)) {
    return null; // Auth successful via X-Admin-Key header
  }

  // Collect token candidates: X-Admin-Key (as Firebase token) and Authorization Bearer
  const authHeader = request.headers.get('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Try Bearer token as admin key first (timing-safe)
  if (bearerToken && expectedKey && timingSafeEqual(bearerToken, expectedKey)) {
    return null; // Auth successful via admin key in Bearer header
  }

  // Check __session cookie (for SSR page loads where browser can't send auth headers)
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionMatch = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
  const cookieToken = sessionMatch ? sessionMatch[1] : null;

  // Try any available token as Firebase ID token from admin user
  const tokenCandidates = [bearerToken, adminKeyHeader, cookieToken].filter(Boolean) as string[];
  for (const token of tokenCandidates) {
    try {
      const env = locals?.runtime?.env;
      const { initFirebaseEnv, verifyUserToken } = await import('./firebase-rest');
      initFirebaseEnv({
        FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
        FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      });
      // Ensure admin UIDs/emails are loaded from runtime env (Cloudflare secrets)
      initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
      const userId = await verifyUserToken(token);
      if (userId && await isAdmin(userId)) {
        return null; // Auth successful via Firebase admin token
      }
    } catch (e: unknown) {
      // Token verification failed, try next candidate
      console.error('[requireAdminAuth] Token verification failed:', e instanceof Error ? e.message : e);
    }
  }

  if (!expectedKey) {
    return ApiErrors.serverError('Admin key not configured');
  }

  return ApiErrors.unauthorized('Invalid or missing admin credentials');
}

// Check if user is admin by UID
export async function isAdmin(uid: string): Promise<boolean> {
  if (getAdminUids().includes(uid)) return true;

  try {
    // Check admins collection
    const adminDoc = await getDocument('admins', uid);
    if (adminDoc) return true;

    // Check if user has admin role
    const userDoc = await getDocument('users', uid);
    if (userDoc?.isAdmin || userDoc?.roles?.admin) return true;
  } catch (e: unknown) {
    console.error('[isAdmin] Failed to check admin status:', e instanceof Error ? e.message : e);
  }

  return false;
}

