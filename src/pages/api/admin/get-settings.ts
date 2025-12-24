// src/pages/api/admin/get-settings.ts
// Get public settings (feature flags) - no auth required
import type { APIRoute } from 'astro';
import { getSettings } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async () => {
  // No auth required - these are public feature flags
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
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      settings: settingsData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[get-settings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get settings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
