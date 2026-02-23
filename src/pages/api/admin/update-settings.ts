// src/pages/api/admin/update-settings.ts
// Comprehensive admin settings API - handles artist permissions, livestream config, and system settings

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument } from '../../../lib/firebase-rest';
import { successResponse, errorResponse, ApiErrors, parseJsonBody, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/update-settings');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const updateSettingsSchema = z.object({
  action: z.enum(['save', 'reset']),
  settings: z.record(z.any()).optional(),
  section: z.string().optional(),
  sectionData: z.record(z.any()).optional(),
  adminKey: z.string().optional(),
});

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

// GET: Load settings (admin only)
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-settings-get:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;

  // SECURITY: Require admin authentication for viewing all settings
  // This prevents exposing system configuration to unauthorized users
  const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

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
        return successResponse({ [section]: settings[section as keyof typeof settings] });
      }

      return successResponse({ settings });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('GET Error:', error);
    return ApiErrors.serverError('Failed to load settings');
  }
};

// POST: Save settings
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-settings-post:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;

  try {
    const data = await parseJsonBody<Record<string, unknown>>(request);
    if (!data) {
      return ApiErrors.badRequest('Invalid request body');
    }

    const parsed = updateSettingsSchema.safeParse(data);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, settings, section, sectionData } = parsed.data;

    // Validate admin auth (timing-safe comparison)
    const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, data);
    if (authError) return authError;

    if (action === 'save') {
      // If saving a specific section
      if (section && sectionData) {
        await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
          [section]: sectionData,
          updatedAt: new Date().toISOString()
        });

        return successResponse({
          message: `${section} settings saved`
        });
      }

      // Save all settings
      if (settings) {
        await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
          ...settings,
          updatedAt: new Date().toISOString()
        });

        return successResponse({
          message: 'All settings saved successfully'
        });
      }

      return ApiErrors.badRequest('No settings provided');
    }

    if (action === 'reset') {
      // If resetting a specific section
      if (section && DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS]) {
        await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
          [section]: DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS],
          updatedAt: new Date().toISOString()
        });

        return successResponse({
          message: `${section} reset to defaults`
        });
      }

      // Reset all settings
      await setDocument(SETTINGS_COLLECTION, SETTINGS_DOC_ID, {
        ...DEFAULT_SETTINGS,
        updatedAt: new Date().toISOString()
      });

      return successResponse({
        message: 'All settings reset to defaults'
      });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('POST Error:', error);
    return ApiErrors.serverError('Failed to save settings');
  }
};
