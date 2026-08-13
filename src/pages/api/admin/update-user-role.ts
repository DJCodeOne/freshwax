// src/pages/api/admin/update-user-role.ts
// Update user roles in the users collection

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { saGetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { resolvePendingRoleRequests } from '../../../lib/roles/pending-requests';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, successResponse, jsonResponse, createLogger } from '../../../lib/api-utils';
import { logError } from '../../../lib/error-logger';

const log = createLogger('admin/update-user-role');

const updateUserRoleParamsSchema = z.object({
  userId: z.string().min(1),
  role: z.string().min(1),
  value: z.string().optional(),
  confirm: z.string().optional(),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-user-role:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const params = {
    userId: url.searchParams.get('userId') || undefined,
    role: url.searchParams.get('role') || undefined,
    value: url.searchParams.get('value') || undefined,
    confirm: url.searchParams.get('confirm') || undefined,
  };

  const parsed = updateUserRoleParamsSchema.safeParse(params);
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }

  const { userId, role, value, confirm } = parsed.data;

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  // Derived from `value` alone, and declared out here so the catch block can
  // report what was actually attempted.
  const newValue = value === 'true' || value === '1';

  try {
    // Get current user document
    const user = await saGetDocument(serviceAccountKey, projectId, 'users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    const currentRoles = user.roles || {};

    if (confirm !== 'yes') {
      return jsonResponse({
        message: 'Preview of role change',
        userId,
        email: user.email,
        displayName: user.displayName,
        currentRoles,
        change: {
          role,
          from: currentRoles[role],
          to: newValue
        },
        usage: 'Add &confirm=yes to apply'
      });
    }

    // Apply the update - update the entire roles object to avoid nested field issues
    const updatedRoles = { ...currentRoles, [role]: newValue };
    await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, {
      roles: updatedRoles
    });

    // Granting a role here is a second approval path: if the user applied for
    // this role, their pendingRoleRequests doc must be closed out too, or it
    // sits "pending" forever and clutters the Approvals tab with people who are
    // already live. Only on grant — revoking a role should not retroactively
    // resolve anything, and must never re-open a settled request. The helper
    // re-checks updatedRoles itself, so a request whose role is not actually
    // held stays pending.
    let resolvedRequests = 0;
    if (newValue) {
      resolvedRequests = await resolvePendingRoleRequests(userId, updatedRoles);
    }

    return successResponse({ message: `Updated ${role} role to ${newValue}`,
      userId,
      email: user.email,
      previousValue: currentRoles[role],
      newValue,
      resolvedRequests });
  } catch (error: unknown) {
    // This used to return a bare 'Unknown error' and discard the cause entirely,
    // so a failed role change was indistinguishable from any other 500 and left
    // no trace anywhere. Role changes are exactly the operation you need a
    // record of when a partner reports they cannot upload or get paid.
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    log.error(`Failed to set role "${role}"=${newValue} on user ${userId}:`, message);

    // Also record to D1 so it surfaces in /admin/errors rather than only in
    // `wrangler tail`. Awaited deliberately: a bare un-awaited promise is killed
    // when the Worker isolate is torn down. logError swallows its own failures.
    await logError({
      source: 'server',
      level: 'error',
      message: `update-user-role failed: ${message}`,
      stack,
      endpoint: '/api/admin/update-user-role',
      statusCode: 500,
      userId,
      metadata: { role, value: newValue, targetUserId: userId },
    }, env);

    return ApiErrors.serverError('Failed to update user role');
  }
};
