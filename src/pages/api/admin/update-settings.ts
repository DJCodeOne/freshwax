// src/pages/api/admin/update-settings.ts
// Comprehensive admin settings API - handles artist permissions, livestream config, and system settings

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();
const SETTINGS_DOC = 'system/admin-settings';

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
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const section = url.searchParams.get('section'); // Optional: get specific section only
    
    if (action === 'load' || !action) {
      const docRef = db.doc(SETTINGS_DOC);
      const docSnap = await docRef.get();
      
      let settings = DEFAULT_SETTINGS;
      
      if (docSnap.exists) {
        const data = docSnap.data();
        // Merge with defaults to ensure all fields exist
        settings = {
          artistEditableFields: { ...DEFAULT_SETTINGS.artistEditableFields, ...(data?.artistEditableFields || {}) },
          livestream: { ...DEFAULT_SETTINGS.livestream, ...(data?.livestream || {}) },
          releaseDefaults: { ...DEFAULT_SETTINGS.releaseDefaults, ...(data?.releaseDefaults || {}) },
          notifications: { ...DEFAULT_SETTINGS.notifications, ...(data?.notifications || {}) }
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
export const POST: APIRoute = async ({ request }) => {
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
      const docRef = db.doc(SETTINGS_DOC);
      
      // If saving a specific section
      if (section && sectionData) {
        await docRef.set({
          [section]: sectionData,
          updatedAt: new Date().toISOString()
        }, { merge: true });
        
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
        await docRef.set({
          ...settings,
          updatedAt: new Date().toISOString()
        }, { merge: true });
        
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
      const docRef = db.doc(SETTINGS_DOC);
      
      // If resetting a specific section
      if (section && DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS]) {
        await docRef.set({
          [section]: DEFAULT_SETTINGS[section as keyof typeof DEFAULT_SETTINGS],
          updatedAt: new Date().toISOString()
        }, { merge: true });
        
        return new Response(JSON.stringify({
          success: true,
          message: `${section} reset to defaults`
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Reset all settings
      await docRef.set({
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
