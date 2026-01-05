// src/pages/api/admin/migrate-to-d1.ts
// One-time migration endpoint to copy Firebase data to D1
// Run this once after deploying the D1 schema

import type { APIContext } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { d1UpsertRelease, d1UpsertMix, d1UpsertMerch } from '../../../lib/d1-catalog';

export const prerender = false;

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

export async function POST({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const env = (locals as any).runtime?.env;
    const db = env?.DB;

    if (!db) {
      return new Response(JSON.stringify({
        success: false,
        error: 'D1 database not available'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check for admin key
    const authHeader = request.headers.get('Authorization');
    const adminKey = env?.ADMIN_KEY || 'fw_admin_7k9mP2xR8nQ5vL3wT6yH4jC1bN0sA9gF5dE2uI8oX7z';

    if (authHeader !== `Bearer ${adminKey}`) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const results = {
      releases: { total: 0, migrated: 0, errors: 0 },
      mixes: { total: 0, migrated: 0, errors: 0 },
      merch: { total: 0, migrated: 0, errors: 0 }
    };

    // --- Migrate Releases ---
    console.log('[Migration] Starting releases migration...');
    try {
      const releases = await queryCollection('releases', { limit: 500 });
      results.releases.total = releases.length;

      for (const release of releases) {
        try {
          const success = await d1UpsertRelease(db, release.id, release);
          if (success) {
            results.releases.migrated++;
          } else {
            results.releases.errors++;
          }
        } catch (e) {
          console.error('[Migration] Error migrating release:', release.id, e);
          results.releases.errors++;
        }
      }
      console.log('[Migration] Releases done:', results.releases);
    } catch (e) {
      console.error('[Migration] Error fetching releases:', e);
    }

    // --- Migrate DJ Mixes ---
    console.log('[Migration] Starting dj-mixes migration...');
    try {
      const mixes = await queryCollection('dj-mixes', { limit: 500 });
      results.mixes.total = mixes.length;

      for (const mix of mixes) {
        try {
          const success = await d1UpsertMix(db, mix.id, mix);
          if (success) {
            results.mixes.migrated++;
          } else {
            results.mixes.errors++;
          }
        } catch (e) {
          console.error('[Migration] Error migrating mix:', mix.id, e);
          results.mixes.errors++;
        }
      }
      console.log('[Migration] DJ Mixes done:', results.mixes);
    } catch (e) {
      console.error('[Migration] Error fetching mixes:', e);
    }

    // --- Migrate Merch ---
    console.log('[Migration] Starting merch migration...');
    try {
      const merch = await queryCollection('merch', { limit: 500 });
      results.merch.total = merch.length;

      for (const item of merch) {
        try {
          const success = await d1UpsertMerch(db, item.id, item);
          if (success) {
            results.merch.migrated++;
          } else {
            results.merch.errors++;
          }
        } catch (e) {
          console.error('[Migration] Error migrating merch:', item.id, e);
          results.merch.errors++;
        }
      }
      console.log('[Migration] Merch done:', results.merch);
    } catch (e) {
      console.error('[Migration] Error fetching merch:', e);
    }

    const totalMigrated = results.releases.migrated + results.mixes.migrated + results.merch.migrated;
    const totalErrors = results.releases.errors + results.mixes.errors + results.merch.errors;

    return new Response(JSON.stringify({
      success: true,
      message: `Migration complete: ${totalMigrated} items migrated, ${totalErrors} errors`,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Migration] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// GET - Check migration status (count records in D1)
export async function GET({ locals }: APIContext) {
  try {
    const env = (locals as any).runtime?.env;
    const db = env?.DB;

    if (!db) {
      return new Response(JSON.stringify({
        success: false,
        error: 'D1 database not available'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const [releases, mixes, merch] = await Promise.all([
      db.prepare('SELECT COUNT(*) as count FROM releases_v2').first(),
      db.prepare('SELECT COUNT(*) as count FROM dj_mixes').first(),
      db.prepare('SELECT COUNT(*) as count FROM merch').first()
    ]);

    return new Response(JSON.stringify({
      success: true,
      d1_counts: {
        releases: releases?.count || 0,
        dj_mixes: mixes?.count || 0,
        merch: merch?.count || 0
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Migration] Status check error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
