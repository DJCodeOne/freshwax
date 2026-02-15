// src/pages/api/auth/init-user.ts
// Server-side user initialization after Firebase Auth sign-in/registration
// Replaces client-side Firestore SDK calls (~200KB saved from login/register pages)

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, getDocument, setDocument, queryCollection } from '../../../lib/firebase-rest';

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
    return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const {
    action,         // 'login' | 'register' | 'google-login' | 'google-register'
    displayName,    // For registration
    email,          // User email
    provider,       // 'email' | 'Google'
    photoURL,       // For Google sign-in
    // Role requests (register only)
    requestArtist,
    requestMerchSeller,
    requestVinylSeller,
    // Role request details
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
  } = body;

  if (!action) {
    return new Response(JSON.stringify({ success: false, error: 'Missing action' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const now = new Date().toISOString();

    // ==================== GOOGLE LOGIN / GOOGLE REGISTER ====================
    if (action === 'google-login' || action === 'google-register') {
      // Check if user already exists in Firestore
      const existingUser = await getDocument('users', userId);

      if (existingUser) {
        // User exists - for google-register, signal that they should redirect to dashboard
        if (action === 'google-register') {
          return new Response(JSON.stringify({
            success: true,
            exists: true,
            message: 'User already exists'
          }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          });
        }
        // google-login: user exists, nothing to do
        return new Response(JSON.stringify({ success: true, exists: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'display_name_taken',
          message: `The display name "${googleDisplayName}" is already taken. Please register with email and choose a different display name.`
        }), {
          status: 409, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Create the user document
      const userData: Record<string, any> = {
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

      return new Response(JSON.stringify({
        success: true,
        exists: false,
        created: true
      }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // ==================== EMAIL LOGIN (orphan account creation) ====================
    if (action === 'login') {
      // This is called when login detects the user doesn't exist in Firestore
      // (orphaned Auth account - has Firebase Auth but no Firestore doc)
      const loginDisplayName = displayName || (email ? email.split('@')[0] : 'User');

      const userData: Record<string, any> = {
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

      return new Response(JSON.stringify({ success: true, created: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // ==================== EMAIL REGISTRATION ====================
    if (action === 'register') {
      if (!displayName || displayName.length < 2) {
        return new Response(JSON.stringify({ success: false, error: 'Display name is required (min 2 chars)' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Build user document
      const userData: Record<string, any> = {
        uid: userId,
        email: email || authEmail || '',
        displayName: displayName,
        displayNameLower: displayName.toLowerCase(),
        provider: 'email',
        emailVerified: false,
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
        pendingRoles: {} as Record<string, any>
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

      // Write pending role requests to separate collection (for REST API access / admin)
      const rolePromises: Promise<any>[] = [];

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
        await Promise.all(rolePromises);
      }

      return new Response(JSON.stringify({ success: true, created: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[auth/init-user] Error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to initialize user profile'
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};
