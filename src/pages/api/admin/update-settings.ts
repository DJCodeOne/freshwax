// src/pages/api/admin/update-settings.ts
// Comprehensive admin settings API - handles artist permissions, livestream config, and system settings

import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Settings document location
const SETTINGS_COLLECTION = 'system';
const SETTINGS_DOC_ID = 'admin-settings';

// Default settings (used if not set in Firebase)
const DEFAULT_SETTINGS = {
  artistEditableFields: {
    releaseDescription: true,
    trackPrice: true,
    pricePerSale: false,
    bpm: true,
    key: true,
    genre: false,
    releaseDate: false,
    masteredBy: false,
    copyrightHolder: false,
    socialLinks: false,
    featured: true,
    remixer: true
  },
  livestream: {
    defaultDailyHours: 2,
    defaultWeeklySlots: 1,
    streamKeyRevealMinutes: 15,
    gracePeriodMinutes: 3,
    sessionEndCountdown: 10,
    requiredMixes: 1,
    requiredLikes: 10,
    allowBypassRequests: true,
    allowGoLiveNow: true,
    allowGoLiveAfter: true,
    allowTakeover: true
  },
  releaseDefaults: {
    defaultStatus: 'pending',
    autoApprove: false,
    requireArtwork: true,
    requirePreview: true
  },
  notifications: {
    emailOnNewRelease: true,
    emailOnArtistEdit: false,
    emailOnBypassRequest: true,
    emailOnDJGoLive: false
  }
};

// GET: Load settings
export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase env from Cloudflare runtime
  const env = (locals as any).runtime?.env;
  if (env) initFirebaseEnv(env);

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const section = url.searchParams.get('section'); // Optional: get specific section only

    if (action === 'load' || !action) {
      const docData = await getDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID);

      let settings = DEFAULT_SETTINGS;

      if (docData) {
        // Merge with defaults to ensure all fields exist
        settings = {
          artistEditableFields: { ...DEFAULT_SETTINGS.artistEditableFields, ...(docData.artistEditableFields || {}) },
          livestream: { ...DEFAULT_SETTINGS.livestream, ...(docData.livestream || {}) },
          releaseDefaults: { ...DEFAULT_SETTINGS.releaseDefaults, ...(docData.releaseDefaults || {}) },
          notifications: { ...DEFAULT_SETTINGS.notifications, ...(docData.notifications || {}) }
        };
      }

      // If specific section requested, return just that
      if (section && settings[section as keyof typeof settings]) {
        return new Response(JSON.stringify({
          success: true,
          [section]: settings[section as keyof typeof settings]
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        settings
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[update-settings] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to load settings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Save settings
export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase env from Cloudflare runtime
  const env = (locals as any).runtime?.env;
  if (env) initFirebaseEnv(env);

  try {
    const data = await request.json();
    const { action, settings, adminKey, section, sectionData } = data;

    // Basic admin key validation
    if (adminKey !== 'fresh-wax-admin-2024') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'save') {
      // If saving a specific section
      if (section && sectionData) {
        await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
          [section]: sectionData,
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          message: `${section} settings saved`
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Save all settings
      if (settings) {
        await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
          ...settings,
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'All settings saved successfully'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: false,
        error: 'No settings provided'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'reset') {
      // If resetting a specific section
      if (section && DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS]) {
        await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
          [section]: DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS],
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          message: `${section} reset to defaults`
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Reset all settings
      await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
        ...DEFAULT_SETTINGS,
        updatedAt: new Date().toISOString()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'All settings reset to defaults'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[update-settings] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to save settings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
