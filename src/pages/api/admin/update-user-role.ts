// src/pages/api/admin/update-user-role.ts
// Update user roles in the users collection

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { saGetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, successResponse, jsonResponse } from '../../../lib/api-utils';

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

  try {
    // Get current user document
    const user = await saGetDocument(serviceAccountKey, projectId, 'users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    const currentRoles = user.roles || {};
    const newValue = value === 'true' || value === '1';

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

    return successResponse({ message: `Updated ${role} role to ${newValue}`,
      userId,
      email: user.email,
      previousValue: currentRoles[role],
      newValue });
  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
