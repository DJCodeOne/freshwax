// src/pages/api/admin/fix-submitter-ids.ts
// Migration script to backfill submitterId on releases and ledger entries
// Run via: GET /api/admin/fix-submitter-ids?confirm=yes

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saSetDocument, saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';
import { initAdminEnv } from '../../../lib/admin';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm');
  const dryRun = url.searchParams.get('dryRun') === 'yes';

  // Initialize environment
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS || '',
  });

  // Require confirmation
  if (confirm !== 'yes') {
    return new Response(JSON.stringify({
      message: 'Migration script to fix submitterId on releases and ledger entries',
      warning: 'This will update releases and ledger entries with missing submitterId',
      usage: 'Add ?confirm=yes to run the migration',
      dryRunUsage: 'Add ?confirm=yes&dryRun=yes to preview without writing'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    console.log('[FixSubmitterIds] Starting migration...');
    console.log('[FixSubmitterIds] Dry run:', dryRun);

    // Get service account for Firebase writes
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Firebase service account not configured',
        hint: 'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build service account key JSON
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

    const results = {
      releases: {
        total: 0,
        fixed: 0,
        alreadyOk: 0,
        noUserId: 0,
        errors: 0,
        details: [] as any[]
      },
      ledger: {
        total: 0,
        fixed: 0,
        alreadyOk: 0,
        noRelease: 0,
        errors: 0,
        details: [] as any[]
      }
    };

    // STEP 1: Fix releases - copy userId to submitterId where missing
    console.log('[FixSubmitterIds] Step 1: Fixing releases...');

    let releases: any[] = [];
    try {
      releases = await saQueryCollection(serviceAccountKey, projectId, 'releases', {
        limit: 5000
      });
    } catch (e) {
      console.log('[FixSubmitterIds] Error fetching releases:', e);
    }

    results.releases.total = releases.length;
    console.log(`[FixSubmitterIds] Found ${releases.length} releases`);

    // Build a map of release IDs to submitter IDs for ledger updates
    const releaseSubmitterMap: Map<string, { submitterId: string; submitterEmail?: string; artistName?: string }> = new Map();

    for (const release of releases) {
      try {
        const hasSubmitterId = release.submitterId && release.submitterId.trim() !== '';
        const hasUploadedBy = release.uploadedBy && release.uploadedBy.trim() !== '';
        const hasUserId = release.userId && release.userId.trim() !== '';

        // Determine the correct submitterId
        const correctSubmitterId = release.submitterId || release.uploadedBy || release.userId || null;

        if (correctSubmitterId) {
          // Store in map for ledger updates
          releaseSubmitterMap.set(release.id, {
            submitterId: correctSubmitterId,
            submitterEmail: release.submitterEmail || release.metadata?.email || null,
            artistName: release.artistName || release.artist || null
          });
        }

        if (hasSubmitterId) {
          results.releases.alreadyOk++;
          continue;
        }

        if (!hasUserId && !hasUploadedBy) {
          results.releases.noUserId++;
          results.releases.details.push({
            releaseId: release.id,
            artistName: release.artistName || release.artist,
            issue: 'No userId or uploadedBy to copy'
          });
          continue;
        }

        // Need to fix - set submitterId from uploadedBy or userId
        const newSubmitterId = hasUploadedBy ? release.uploadedBy : release.userId;

        if (dryRun) {
          results.releases.details.push({
            releaseId: release.id,
            artistName: release.artistName || release.artist,
            currentSubmitterId: release.submitterId || 'NOT SET',
            wouldSetTo: newSubmitterId,
            source: hasUploadedBy ? 'uploadedBy' : 'userId'
          });
        } else {
          await saUpdateDocument(serviceAccountKey, projectId, 'releases', release.id, {
            submitterId: newSubmitterId,
            updatedAt: new Date().toISOString()
          });
        }

        results.releases.fixed++;
        console.log(`[FixSubmitterIds] Fixed release ${release.id}: submitterId=${newSubmitterId}`);

      } catch (err) {
        results.releases.errors++;
        console.error(`[FixSubmitterIds] Error fixing release ${release.id}:`, err);
      }
    }

    // STEP 2: Fix ledger entries - add submitterId by looking up release
    console.log('[FixSubmitterIds] Step 2: Fixing ledger entries...');

    let ledgerEntries: any[] = [];
    try {
      ledgerEntries = await saQueryCollection(serviceAccountKey, projectId, 'salesLedger', {
        limit: 5000
      });
    } catch (e) {
      console.log('[FixSubmitterIds] Error fetching ledger entries:', e);
    }

    results.ledger.total = ledgerEntries.length;
    console.log(`[FixSubmitterIds] Found ${ledgerEntries.length} ledger entries`);

    for (const entry of ledgerEntries) {
      try {
        // Check if already has submitterId or artistId
        const hasSubmitterId = entry.submitterId && entry.submitterId.trim() !== '';
        const hasArtistId = entry.artistId && entry.artistId.trim() !== '';

        if (hasSubmitterId || hasArtistId) {
          results.ledger.alreadyOk++;
          continue;
        }

        // Look up release from items to get submitterId
        const items = entry.items || [];
        let foundSubmitterId: string | null = null;
        let foundSubmitterEmail: string | null = null;
        let foundArtistName: string | null = null;
        let sourceReleaseId: string | null = null;

        for (const item of items) {
          const releaseId = item.id || item.releaseId;
          if (releaseId && releaseSubmitterMap.has(releaseId)) {
            const info = releaseSubmitterMap.get(releaseId)!;
            foundSubmitterId = info.submitterId;
            foundSubmitterEmail = info.submitterEmail || null;
            foundArtistName = info.artistName || item.artist || null;
            sourceReleaseId = releaseId;
            break;
          }
        }

        if (!foundSubmitterId) {
          results.ledger.noRelease++;
          results.ledger.details.push({
            ledgerId: entry.id,
            orderId: entry.orderId,
            orderNumber: entry.orderNumber,
            issue: 'Could not find release to lookup submitterId',
            items: items.map((i: any) => ({ id: i.id, title: i.title }))
          });
          continue;
        }

        // Update ledger entry with submitterId
        if (dryRun) {
          results.ledger.details.push({
            ledgerId: entry.id,
            orderNumber: entry.orderNumber,
            wouldSetSubmitterId: foundSubmitterId,
            sourceReleaseId,
            artistName: foundArtistName
          });
        } else {
          await saUpdateDocument(serviceAccountKey, projectId, 'salesLedger', entry.id, {
            submitterId: foundSubmitterId,
            submitterEmail: foundSubmitterEmail,
            artistId: foundSubmitterId,
            artistName: foundArtistName
          });
        }

        results.ledger.fixed++;
        console.log(`[FixSubmitterIds] Fixed ledger ${entry.orderNumber}: submitterId=${foundSubmitterId}`);

      } catch (err) {
        results.ledger.errors++;
        console.error(`[FixSubmitterIds] Error fixing ledger ${entry.id}:`, err);
      }
    }

    console.log('[FixSubmitterIds] Migration complete:', results);

    return new Response(JSON.stringify({
      success: true,
      dryRun,
      results,
      summary: {
        releases: `${results.releases.fixed} fixed, ${results.releases.alreadyOk} already OK, ${results.releases.noUserId} missing userId`,
        ledger: `${results.ledger.fixed} fixed, ${results.ledger.alreadyOk} already OK, ${results.ledger.noRelease} no release found`
      },
      message: dryRun
        ? `Dry run complete. Would fix ${results.releases.fixed} releases and ${results.ledger.fixed} ledger entries.`
        : `Migration complete. Fixed ${results.releases.fixed} releases and ${results.ledger.fixed} ledger entries.`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[FixSubmitterIds] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Migration failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
