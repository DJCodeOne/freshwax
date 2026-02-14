// src/pages/api/admin/get-settings.ts
// Get public settings (feature flags) - no auth required
import type { APIRoute } from 'astro';
import { getSettings } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

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

  } catch (error: any) {
    console.error('[get-settings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get settings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
