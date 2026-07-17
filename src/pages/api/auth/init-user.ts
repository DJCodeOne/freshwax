// src/pages/api/auth/init-user.ts
// Server-side user initialization after Firebase Auth sign-in/registration
// Replaces client-side Firestore SDK calls (~200KB saved from login/register pages)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, getDocument, setDocument, queryCollection } from '../../../lib/firebase-rest';
import { errorResponse, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { recordMarketingConsent } from '../../../lib/newsletter-consent';

const log = createLogger('auth/init-user');

const InitUserSchema = z.object({
  action: z.enum(['login', 'register', 'google-login', 'google-register']),
  displayName: z.string().max(100).optional(),
  email: z.string().email().max(320).optional(),
  provider: z.enum(['email', 'Google']).optional(),
  photoURL: z.string().url().max(2048).optional().nullable(),
  marketingConsent: z.boolean().optional(),
  requestArtist: z.boolean().optional(),
  requestMerchSeller: z.boolean().optional(),
  requestVinylSeller: z.boolean().optional(),
  artistName: z.string().max(200).optional(),
  artistBio: z.string().max(2000).optional(),
  artistLinks: z.string().max(1000).optional(),
  businessName: z.string().max(200).optional(),
  merchDescription: z.string().max(2000).optional(),
  merchWebsite: z.string().max(500).optional(),
  vinylStoreName: z.string().max(200).optional(),
  vinylDescription: z.string().max(2000).optional(),
  vinylLocation: z.string().max(200).optional(),
  vinylDiscogsUrl: z.string().max(500).optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  // Rate limit: auth attempts - 10 per 15 minutes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`auth-init:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Verify the Firebase ID token
  const { userId, email: authEmail, error: authError } = await verifyRequestUser(request);
  if (!userId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (e: unknown) {
    return ApiErrors.badRequest('Invalid JSON body');
  }

  const parsed = InitUserSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }

  const {
    action,
    displayName,
    email,
    provider,
    photoURL,
    marketingConsent,
    requestArtist,
    requestMerchSeller,
    requestVinylSeller,
    artistName,
    artistBio,
    artistLinks,
    businessName,
    merchDescription,
    merchWebsite,
    vinylStoreName,
    vinylDescription,
    vinylLocation,
    vinylDiscogsUrl,
  } = parsed.data;

  try {
    const now = new Date().toISOString();

    // ==================== GOOGLE LOGIN / GOOGLE REGISTER ====================
    if (action === 'google-login' || action === 'google-register') {
      // Check if user already exists in Firestore
      const existingUser = await getDocument('users', userId);

      if (existingUser) {
        // User exists - for google-register, signal that they should redirect to dashboard
        if (action === 'google-register') {
          return successResponse({ exists: true, message: 'User already exists' });
        }
        // google-login: user exists, nothing to do
        return successResponse({ exists: true });
      }

      // ---- Dedupe guard ----------------------------------------------------
      // Firebase Auth treats gmail.com and googlemail.com as DIFFERENT
      // identities, and a Google sign-in is a different identity from an
      // email/password account with the "same" address. Without this guard a
      // Google sign-in for an email that already has an account silently
      // creates a SECOND profile (different UID), orphaning the user from their
      // real account (roles, partner status, bypass, orders).
      //
      // If the normalised email already belongs to a DIFFERENT, non-deleted
      // account, refuse to create a duplicate and tell them to use their
      // original sign-in method (their password account) instead.
      const normEmail = (email || authEmail || '')
        .trim()
        .toLowerCase()
        .replace(/@googlemail\.com$/i, '@gmail.com');
      if (normEmail) {
        const emailVariants = Array.from(new Set([normEmail, (email || authEmail || '').trim()]));
        const lookups = emailVariants.flatMap((value) => [
          queryCollection('users', { filters: [{ field: 'email', op: 'EQUAL', value }], limit: 5, skipCache: true }).catch(() => []),
          queryCollection('artists', { filters: [{ field: 'email', op: 'EQUAL', value }], limit: 5, skipCache: true }).catch(() => []),
        ]);
        const matches = (await Promise.all(lookups)).flat();
        const conflict = matches.some((d) => d && d.id !== userId && d.deleted !== true);
        if (conflict) {
          log.warn(`[init-user] Blocked duplicate Google account for existing email (uid ${userId})`);
          return errorResponse('An account already exists for this email. Please sign in with your email and password instead of "Sign in with Google".', 409);
        }
      }

      // New user via Google - need display name
      const googleDisplayName = displayName || (email ? email.split('@')[0] : 'User');
      const googleNameLower = googleDisplayName.toLowerCase();

      // Check if display name is already taken
      const nameCheck = await queryCollection('users', {
        filters: [{ field: 'displayNameLower', op: 'EQUAL', value: googleNameLower }],
        limit: 1,
        skipCache: true
      });

      if (nameCheck.length > 0) {
        return errorResponse(`The display name "${googleDisplayName}" is already taken. Please register with email and choose a different display name.`, 409);
      }

      // Create the user document
      const userData: Record<string, unknown> = {
        uid: userId,
        email: email || authEmail || '',
        displayName: googleDisplayName,
        displayNameLower: googleNameLower,
        photoURL: photoURL || null,
        provider: 'Google',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        roles: {
          customer: true,
          dj: true,
          artist: false,
          merchSupplier: false,
          vinylSeller: false,
          admin: false
        },
        pendingRoles: {}
      };

      await setDocument('users', userId, userData);

      return successResponse({ exists: false, created: true });
    }

    // ==================== EMAIL LOGIN (orphan account creation) ====================
    if (action === 'login') {
      // This is called when login detects the user doesn't exist in Firestore
      // (orphaned Auth account - has Firebase Auth but no Firestore doc)
      const loginDisplayName = displayName || (email ? email.split('@')[0] : 'User');

      const userData: Record<string, unknown> = {
        email: email || authEmail || '',
        displayName: loginDisplayName,
        fullName: displayName || '',
        roles: {
          customer: true,
          dj: true,
          artist: false,
          merchSupplier: false,
          vinylSeller: false,
          admin: false
        },
        permissions: {
          canBuy: true,
          canComment: true,
          canRate: true
        },
        approved: false,
        suspended: false,
        createdAt: now,
        registeredAt: now,
        syncedFromAuth: true
      };

      await setDocument('users', userId, userData);

      return successResponse({ created: true });
    }

    // ==================== EMAIL REGISTRATION ====================
    if (action === 'register') {
      if (!displayName || displayName.length < 2) {
        return ApiErrors.badRequest('Display name is required (min 2 chars)');
      }

      // Build user document
      const userData: Record<string, unknown> = {
        uid: userId,
        email: email || authEmail || '',
        displayName: displayName,
        displayNameLower: displayName.toLowerCase(),
        provider: 'email',
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        // Marketing consent as given at signup. The `subscribers` doc is the
        // list of record for sending; this is the per-user audit trail.
        marketingConsent: marketingConsent === true,
        marketingConsentAt: marketingConsent === true ? now : null,
        marketingConsentSource: marketingConsent === true ? 'register' : null,
        roles: {
          customer: true,
          dj: true,
          artist: false,
          merchSupplier: false,
          vinylSeller: false,
          admin: false
        },
        pendingRoles: {} as Record<string, unknown>
      };

      // Add pending role requests
      if (requestArtist) {
        userData.pendingRoles.artist = {
          requestedAt: now,
          status: 'pending',
          artistName: artistName || '',
          bio: artistBio || '',
          links: artistLinks || ''
        };
      }
      if (requestMerchSeller) {
        userData.pendingRoles.merchSeller = {
          requestedAt: now,
          status: 'pending',
          businessName: businessName || '',
          description: merchDescription || '',
          website: merchWebsite || ''
        };
      }
      if (requestVinylSeller) {
        userData.pendingRoles.vinylSeller = {
          requestedAt: now,
          status: 'pending',
          storeName: vinylStoreName || '',
          description: vinylDescription || '',
          location: vinylLocation || '',
          discogsUrl: vinylDiscogsUrl || ''
        };
      }

      // Save user document
      await setDocument('users', userId, userData);

      // Add to the newsletter list if they ticked the box. Awaited (not
      // fire-and-forget — Workers kill bare async) but never allowed to fail
      // the registration.
      if (marketingConsent === true) {
        await recordMarketingConsent({
          email: email || authEmail || '',
          name: displayName,
          source: 'register',
          ip: clientId,
        });
      }

      // Write pending role requests to separate collection (for REST API access / admin)
      const rolePromises: Promise<unknown>[] = [];

      if (requestArtist) {
        rolePromises.push(setDocument('pendingRoleRequests', `${userId}_artist`, {
          id: `${userId}_artist`,
          uid: userId,
          userId: userId,
          roleType: 'artist',
          displayName: displayName,
          email: email || authEmail || '',
          status: 'pending',
          requestedAt: now,
          artistName: artistName || '',
          bio: artistBio || '',
          links: artistLinks || ''
        }));
      }

      if (requestMerchSeller) {
        rolePromises.push(setDocument('pendingRoleRequests', `${userId}_merchSeller`, {
          id: `${userId}_merchSeller`,
          uid: userId,
          userId: userId,
          roleType: 'merchSeller',
          displayName: displayName,
          email: email || authEmail || '',
          status: 'pending',
          requestedAt: now,
          businessName: businessName || '',
          description: merchDescription || '',
          website: merchWebsite || ''
        }));
      }

      if (requestVinylSeller) {
        rolePromises.push(setDocument('pendingRoleRequests', `${userId}_vinylSeller`, {
          id: `${userId}_vinylSeller`,
          uid: userId,
          userId: userId,
          roleType: 'vinylSeller',
          displayName: displayName,
          email: email || authEmail || '',
          status: 'pending',
          requestedAt: now,
          storeName: vinylStoreName || '',
          description: vinylDescription || '',
          location: vinylLocation || '',
          discogsUrl: vinylDiscogsUrl || ''
        }));
      }

      if (rolePromises.length > 0) {
        const results = await Promise.allSettled(rolePromises);
        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
          log.warn(`Failed to save ${failures.length}/${rolePromises.length} role requests`);
        }
      }

      return successResponse({ created: true });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('[auth/init-user] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to initialize user profile');
  }
};
