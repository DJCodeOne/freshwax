// src/pages/api/admin/get-settings.ts
// Get admin settings - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';

export const GET: APIRoute = async () => {
  try {
    const settingsData = await getDocument('settings', 'admin');

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
