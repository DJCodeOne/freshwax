// src/pages/api/admin/get-settings.ts
// Get public settings (feature flags) - no auth required for read
import type { APIRoute } from 'astro';
import { getSettings } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/get-settings');

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`get-settings:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const settingsData = await getSettings();

    if (!settingsData) {
      // Return default settings
      return successResponse({ settings: {
          showMixCharts: false
        } });
    }

    return successResponse({ settings: settingsData });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get settings');
  }
};
