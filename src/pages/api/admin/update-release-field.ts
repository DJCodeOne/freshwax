// src/pages/api/admin/update-release-field.ts
// Update a specific field on a release

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, successResponse, jsonResponse } from '../../../lib/api-utils';

const updateReleaseFieldParamsSchema = z.object({
  releaseId: z.string().min(1),
  field: z.string().min(1),
  value: z.string().optional(),
  confirm: z.string().optional(),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-release-field:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const params = {
    releaseId: url.searchParams.get('releaseId') || undefined,
    field: url.searchParams.get('field') || undefined,
    value: url.searchParams.get('value') || undefined,
    confirm: url.searchParams.get('confirm') || undefined,
  };

  const parsed = updateReleaseFieldParamsSchema.safeParse(params);
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }

  const { releaseId, field, value, confirm } = parsed.data;

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

  // Parse value
  let parsedValue: unknown = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (value === 'null') parsedValue = null;
  else if (value?.startsWith('{') || value?.startsWith('[')) {
    try { parsedValue = JSON.parse(value); } catch { /* keep as string */ }
  }
  else if (!isNaN(Number(value))) parsedValue = Number(value);

  if (confirm !== 'yes') {
    return jsonResponse({
      message: 'Preview of field update',
      releaseId,
      field,
      newValue: parsedValue,
      valueType: typeof parsedValue,
      usage: 'Add &confirm=yes to apply'
    });
  }

  try {
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', releaseId, {
      [field]: parsedValue
    });

    return successResponse({ message: `Updated ${field} to ${parsedValue}`,
      releaseId,
      field,
      newValue: parsedValue });
  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
