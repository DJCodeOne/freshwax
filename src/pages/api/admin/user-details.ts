// src/pages/api/admin/user-details.ts
// Get detailed user information for admin panel

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  try {
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get user from users collection
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Return user data (sanitized)
    return new Response(JSON.stringify({
      success: true,
      user: {
        id: userId,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        createdAt: user.createdAt,
        subscription: user.subscription,
        roles: user.roles,
        usage: user.usage
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[user-details] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch user details'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
