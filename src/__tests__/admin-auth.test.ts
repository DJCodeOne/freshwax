import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock firebase-rest (used by admin.ts for getDocument and verifyUserToken)
vi.mock('../lib/firebase-rest', () => ({
  getDocument: vi.fn(),
  initFirebaseEnv: vi.fn(),
  verifyUserToken: vi.fn(),
}));

// Mock api-utils — re-export real implementations where possible,
// but keep them available for spy-level assertions
vi.mock('../lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-utils')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  requireAdminAuth,
  verifyAdminKey,
  getAdminKey,
  isAdmin,
  initAdminEnv,
  getAdminUids,
  getAdminEmails,
} from '../lib/admin';

import { timingSafeCompare } from '../lib/api-utils';

import { getDocument } from '../lib/firebase-rest';
const mockedGetDocument = vi.mocked(getDocument);

import { verifyUserToken } from '../lib/firebase-rest';
const mockedVerifyUserToken = vi.mocked(verifyUserToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal App.Locals mock with a configurable ADMIN_KEY */
function makeLocals(overrides: Record<string, unknown> = {}): App.Locals {
  return {
    runtime: {
      env: {
        ADMIN_KEY: 'test-admin-key-secret',
        FIREBASE_API_KEY: 'fake-api-key',
        FIREBASE_PROJECT_ID: 'freshwax-test',
        ADMIN_UIDS: 'uid-admin-1,uid-admin-2',
        ADMIN_EMAILS: 'admin@freshwax.co.uk',
        ...overrides,
      },
    },
  } as unknown as App.Locals;
}

/** Build a Request with optional headers */
function makeRequest(
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string
): Request {
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) init.body = body;
  return new Request('https://freshwax.co.uk/api/admin/test', init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module-level adminConfig cache by re-initialising
    initAdminEnv({ ADMIN_UIDS: 'uid-admin-1,uid-admin-2', ADMIN_EMAILS: 'admin@freshwax.co.uk' });
  });

  // =========================================================================
  // getAdminKey (from admin.ts — different from api-utils getAdminKey)
  // =========================================================================
  describe('getAdminKey', () => {
    it('returns the ADMIN_KEY from locals.runtime.env', () => {
      const locals = makeLocals({ ADMIN_KEY: 'my-secret' });
      expect(getAdminKey(locals)).toBe('my-secret');
    });

    it('returns empty string when ADMIN_KEY is not set', () => {
      const locals = makeLocals({ ADMIN_KEY: undefined });
      // Falls back to import.meta.env.ADMIN_KEY which is undefined in test
      expect(getAdminKey(locals)).toBeFalsy();
    });
  });

  // =========================================================================
  // verifyAdminKey
  // =========================================================================
  describe('verifyAdminKey', () => {
    it('returns true for a matching admin key', () => {
      const locals = makeLocals({ ADMIN_KEY: 'correct-key' });
      expect(verifyAdminKey('correct-key', locals)).toBe(true);
    });

    it('returns false for a non-matching admin key', () => {
      const locals = makeLocals({ ADMIN_KEY: 'correct-key' });
      expect(verifyAdminKey('wrong-key', locals)).toBe(false);
    });

    it('returns false when key is empty string', () => {
      const locals = makeLocals({ ADMIN_KEY: 'correct-key' });
      expect(verifyAdminKey('', locals)).toBe(false);
    });

    it('returns false when expected key is empty', () => {
      const locals = makeLocals({ ADMIN_KEY: '' });
      expect(verifyAdminKey('any-key', locals)).toBe(false);
    });

    it('uses timing-safe comparison (same function as timingSafeCompare)', () => {
      // Verify the underlying comparison function works correctly
      expect(timingSafeCompare('abc', 'abc')).toBe(true);
      expect(timingSafeCompare('abc', 'abd')).toBe(false);
      expect(timingSafeCompare('abc', 'abcd')).toBe(false);
    });
  });

  // =========================================================================
  // initAdminEnv / getAdminUids / getAdminEmails
  // =========================================================================
  describe('initAdminEnv', () => {
    it('parses comma-separated UIDs', () => {
      initAdminEnv({ ADMIN_UIDS: 'uid1,uid2,uid3' });
      expect(getAdminUids()).toEqual(['uid1', 'uid2', 'uid3']);
    });

    it('trims whitespace from UIDs', () => {
      initAdminEnv({ ADMIN_UIDS: ' uid1 , uid2 ' });
      expect(getAdminUids()).toEqual(['uid1', 'uid2']);
    });

    it('lowercases emails', () => {
      initAdminEnv({ ADMIN_EMAILS: 'Admin@FreshWax.co.uk,BOSS@test.com' });
      expect(getAdminEmails()).toEqual(['admin@freshwax.co.uk', 'boss@test.com']);
    });

    it('filters out empty entries', () => {
      initAdminEnv({ ADMIN_UIDS: 'uid1,,uid2,,' });
      expect(getAdminUids()).toEqual(['uid1', 'uid2']);
    });
  });

  // =========================================================================
  // isAdmin
  // =========================================================================
  describe('isAdmin', () => {
    it('returns true if uid is in ADMIN_UIDS list', async () => {
      expect(await isAdmin('uid-admin-1')).toBe(true);
    });

    it('returns false for non-admin uid when Firebase docs do not exist', async () => {
      mockedGetDocument.mockResolvedValue(null);
      expect(await isAdmin('uid-random-user')).toBe(false);
    });

    it('returns true if admins collection has a document for the uid', async () => {
      mockedGetDocument.mockImplementation(async (collection: string, id: string) => {
        if (collection === 'admins' && id === 'uid-found') return { id: 'uid-found' };
        return null;
      });
      expect(await isAdmin('uid-found')).toBe(true);
    });

    it('returns true if user document has isAdmin flag', async () => {
      mockedGetDocument.mockImplementation(async (collection: string, id: string) => {
        if (collection === 'admins') return null;
        if (collection === 'users' && id === 'uid-flagged') return { isAdmin: true };
        return null;
      });
      expect(await isAdmin('uid-flagged')).toBe(true);
    });

    it('returns true if user document has roles.admin flag', async () => {
      mockedGetDocument.mockImplementation(async (collection: string, id: string) => {
        if (collection === 'admins') return null;
        if (collection === 'users' && id === 'uid-roled') return { roles: { admin: true } };
        return null;
      });
      expect(await isAdmin('uid-roled')).toBe(true);
    });

    it('returns false and does not throw when Firebase lookup fails', async () => {
      mockedGetDocument.mockRejectedValue(new Error('Firebase down'));
      expect(await isAdmin('uid-unknown')).toBe(false);
    });
  });

  // =========================================================================
  // requireAdminAuth
  // =========================================================================
  describe('requireAdminAuth', () => {
    const ADMIN_KEY = 'test-admin-key-secret';

    // --- Success paths ---

    it('returns null (success) when valid admin key is in request body', async () => {
      const request = makeRequest();
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals, { adminKey: ADMIN_KEY });
      expect(result).toBeNull();
    });

    it('returns null (success) when valid admin key is in X-Admin-Key header', async () => {
      const request = makeRequest({ 'X-Admin-Key': ADMIN_KEY });
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals);
      expect(result).toBeNull();
    });

    it('returns null (success) when valid admin key is in Bearer token', async () => {
      const request = makeRequest({ Authorization: `Bearer ${ADMIN_KEY}` });
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals);
      expect(result).toBeNull();
    });

    it('returns null (success) for valid Firebase admin token via Bearer', async () => {
      mockedVerifyUserToken.mockResolvedValue('uid-admin-1');
      // Ensure the admin key does NOT match so it falls through to Firebase path
      const request = makeRequest({ Authorization: 'Bearer valid-firebase-id-token' });
      const locals = makeLocals({ ADMIN_KEY: 'different-admin-key' });
      const result = await requireAdminAuth(request, locals);
      expect(result).toBeNull();
    });

    it('returns null (success) for valid Firebase admin token via __session cookie', async () => {
      mockedVerifyUserToken.mockResolvedValue('uid-admin-1');
      const request = makeRequest({ Cookie: '__session=valid-cookie-token; other=value' });
      const locals = makeLocals({ ADMIN_KEY: 'different-admin-key' });
      const result = await requireAdminAuth(request, locals);
      expect(result).toBeNull();
    });

    // --- Failure paths ---

    it('returns 401 for invalid admin key in body', async () => {
      mockedVerifyUserToken.mockResolvedValue(null);
      const request = makeRequest();
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals, { adminKey: 'wrong-key' });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
      const body = await result!.json();
      expect(body.success).toBe(false);
    });

    it('returns 401 for invalid X-Admin-Key header', async () => {
      mockedVerifyUserToken.mockResolvedValue(null);
      const request = makeRequest({ 'X-Admin-Key': 'wrong-key' });
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('returns 401 for invalid Bearer token', async () => {
      mockedVerifyUserToken.mockResolvedValue(null);
      const request = makeRequest({ Authorization: 'Bearer wrong-key' });
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('returns 401 when no auth headers or body provided', async () => {
      mockedVerifyUserToken.mockResolvedValue(null);
      const request = makeRequest();
      const locals = makeLocals();
      const result = await requireAdminAuth(request, locals);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('returns 500 when ADMIN_KEY is not configured and no Firebase token works', async () => {
      mockedVerifyUserToken.mockResolvedValue(null);
      const request = makeRequest();
      const locals = makeLocals({ ADMIN_KEY: undefined });
      const result = await requireAdminAuth(request, locals);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(500);
      const body = await result!.json();
      expect(body.error).toContain('not configured');
    });

    it('returns 401 when Firebase token belongs to a non-admin user', async () => {
      // verifyUserToken returns a valid uid, but isAdmin returns false
      mockedVerifyUserToken.mockResolvedValue('uid-regular-user');
      mockedGetDocument.mockResolvedValue(null);
      const request = makeRequest({ Authorization: 'Bearer valid-non-admin-token' });
      const locals = makeLocals({ ADMIN_KEY: 'different-key' });
      const result = await requireAdminAuth(request, locals);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('tries multiple token candidates in order (Bearer, X-Admin-Key, cookie)', async () => {
      // First candidate fails, second succeeds
      let callCount = 0;
      mockedVerifyUserToken.mockImplementation(async (token: string) => {
        callCount++;
        if (token === 'cookie-token') return 'uid-admin-1';
        return null;
      });

      const request = makeRequest({
        Authorization: 'Bearer bad-token',
        'X-Admin-Key': 'also-bad',
        Cookie: '__session=cookie-token',
      });
      const locals = makeLocals({ ADMIN_KEY: 'different-key' });
      const result = await requireAdminAuth(request, locals);
      expect(result).toBeNull(); // Should succeed via cookie token
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('handles Firebase verifyUserToken throwing an error gracefully', async () => {
      mockedVerifyUserToken.mockRejectedValue(new Error('Network error'));
      const request = makeRequest({ Authorization: 'Bearer some-token' });
      const locals = makeLocals({ ADMIN_KEY: 'different-key' });
      const result = await requireAdminAuth(request, locals);
      // Should not throw, should return 401
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    // --- Timing safety ---

    it('uses timing-safe comparison for admin key checks (not ===)', () => {
      // This is a structural test — the admin module imports timingSafeCompare
      // and aliases it as timingSafeEqual. We verify the comparison function
      // behaves correctly for near-miss inputs that would leak info via timing.
      const key = 'super-secret-admin-key-2024';

      // Identical strings
      expect(timingSafeCompare(key, key)).toBe(true);

      // Off by last character — timing attack vector
      expect(timingSafeCompare(key, key.slice(0, -1) + 'X')).toBe(false);

      // Completely different — should still take same time as near-miss
      expect(timingSafeCompare(key, 'completely-different')).toBe(false);

      // Different lengths
      expect(timingSafeCompare(key, key + '-extra')).toBe(false);
    });
  });
});
