// src/pages/api/admin/get-settings.ts
// Get public settings (feature flags) - no auth required for read
import type { APIRoute } from 'astro';
import { getSettings } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`get-settings:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const settingsData = await getSettings();

    if (!settingsData) {
      // Return default settings
      return new Response(JSON.stringify({
        success: true,
        settings: {
          showMixCharts: false
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      settings: settingsData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
    });

  } catch (error: unknown) {
    console.error('[get-settings] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get settings');
  }
};
