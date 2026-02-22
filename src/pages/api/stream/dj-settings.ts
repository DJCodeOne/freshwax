// src/pages/api/stream/dj-settings.ts
// Admin endpoint to add/update DJ settings and grant streaming access
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection } from '../../../lib/firebase-rest';
import { saSetDocument, saUpdateDocument, saDeleteDocument } from '../../../lib/firebase-service-account';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[dj-settings]');
import { verifyAdminKey } from '../../../lib/admin';

const DjSettingsSchema = z.object({
  userId: z.string().max(500).nullish(),
  email: z.string().max(500).nullish(),
  djName: z.string().max(200).nullish(),
  twitchChannel: z.string().max(200).nullish(),
  isApproved: z.boolean().nullish(),
  adminKey: z.string().min(1).max(500),
}).passthrough();

export const prerender = false;

// Build service account key from individual env vars
function getServiceAccountKey(env: Record<string, unknown>): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

// Look up user by email across all collections
async function findUserByEmail(email: string): Promise<{ userId: string; displayName: string; email: string } | null> {
  const [users, customers, artists] = await Promise.all([
    queryCollection('users', {
      filters: [{ field: 'email', op: 'EQUAL', value: email }],
      limit: 1
    }),
    queryCollection('users', {
      filters: [{ field: 'email', op: 'EQUAL', value: email }],
      limit: 1
    }),
    queryCollection('artists', {
      filters: [{ field: 'email', op: 'EQUAL', value: email }],
      limit: 1
    })
  ]);

  if (users.length > 0) {
    return {
      userId: users[0].id,
      displayName: users[0].displayName || users[0].name || users[0].djName || 'DJ',
      email: users[0].email
    };
  } else if (customers.length > 0) {
    return {
      userId: customers[0].id,
      displayName: customers[0].displayName || customers[0].firstName || 'DJ',
      email: customers[0].email
    };
  } else if (artists.length > 0) {
    return {
      userId: artists[0].id,
      displayName: artists[0].displayName || artists[0].artistName || artists[0].name || 'DJ',
      email: artists[0].email
    };
  }

  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    const rawBody = await request.json();
    const parseResult = DjSettingsSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId: providedUserId, email: providedEmail, djName, twitchChannel, isApproved, adminKey } = parseResult.data;

    // Timing-safe admin key check
    if (!verifyAdminKey(adminKey, locals)) {
      return ApiErrors.unauthorized('Unauthorized');
    }

    // Look up user by email if no userId provided
    let userId = providedUserId;
    let email = providedEmail || '';
    let displayName = djName || 'DJ';

    if (!userId && email) {
      const user = await findUserByEmail(email);
      if (!user) {
        return ApiErrors.notFound('User not found with that email. They need to create an account first.');
      }
      userId = user.userId;
      displayName = djName || user.displayName;
      email = user.email;
    }

    if (!userId) {
      return ApiErrors.badRequest('Email or User ID required');
    }

    // Get service account for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    // Generate mount point based on user ID
    const mountPoint = `/live/${userId.substring(0, 8)}`;

    if (isApproved) {
      // Grant access - add to djLobbyBypass collection
      await saSetDocument(serviceAccountKey, projectId, 'djLobbyBypass', userId, {
        email,
        name: displayName,
        twitchChannel: twitchChannel || null,
        mountPoint,
        grantedAt: new Date().toISOString(),
        grantedBy: 'admin'
      });

      // Also set user's bypass flag
      await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, {
        'go-liveBypassed': true,
        bypassedAt: new Date().toISOString(),
        bypassedBy: 'admin'
      });

      log.info(`Granted streaming access to ${displayName} (${userId})`);
    } else {
      // Revoke access
      await saDeleteDocument(serviceAccountKey, projectId, 'djLobbyBypass', userId);

      // Remove bypass flag
      try {
        await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, {
          'go-liveBypassed': false,
          bypassRevokedAt: new Date().toISOString()
        });
      } catch (e: unknown) {
        // User doc might not exist
      }

      log.info(`Revoked streaming access for ${displayName} (${userId})`);
    }

    return new Response(JSON.stringify({
      success: true,
      message: isApproved ? 'DJ added and approved' : 'DJ access revoked',
      mountPoint: isApproved ? mountPoint : null,
      userId,
      djName: displayName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
