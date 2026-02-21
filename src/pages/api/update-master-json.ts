// src/pages/api/update-master-json.ts
// FIXED: Sets status to 'pending' by default, admin must approve before going live
import type { APIRoute } from 'astro';
import { getDocument, setDocument } from '../../lib/firebase-rest';
import { requireAdminAuth } from '../../lib/admin';
import { createLogger } from '../../lib/api-utils';

export const prerender = false;

const logger = createLogger('update-master-json');

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();

    // SECURITY: Require admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { release } = body as { release?: Record<string, unknown> };

    if (!release || !release.id) {
      return new Response(JSON.stringify({
        error: 'Missing release data or release ID'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    logger.info(`[Master JSON] Updating release: ${release.id}`);

    // CRITICAL: Default to pending status unless explicitly set
    // Admin must manually approve and publish from the admin panel
    const releaseData: Record<string, unknown> = {
      ...release,
      updatedAt: new Date().toISOString(),
      createdAt: (release.createdAt as string) || new Date().toISOString(),
      status: (release.status as string) || 'pending', // Default to pending
      published: release.published === true ? true : false, // Explicitly false unless set to true
      approved: release.approved === true ? true : false, // Default to not approved
      storage: 'r2' // Mark that this release uses R2 storage
    };

    logger.info(`[Master JSON] Status: ${releaseData.status}, Published: ${releaseData.published}, Approved: ${releaseData.approved}`);

    // Set the document (will create or update)
    await setDocument('releases', release.id as string, releaseData);

    logger.info(`[Master JSON] Release stored in Firestore [STATUS: ${releaseData.status}]`);

    // Also maintain a master list document for quick access
    const masterListDoc = await getDocument('system', 'releases-master') as Record<string, unknown> | null;

    let releasesList: Array<Record<string, unknown>> = [];
    if (masterListDoc) {
      releasesList = (masterListDoc.releases || []) as Array<Record<string, unknown>>;
    }

    // Check if release already exists in master list
    const existingIndex = releasesList.findIndex((r: Record<string, unknown>) => r.id === release.id);

    // Create summary for master list
    const releaseSummary: Record<string, unknown> = {
      id: release.id,
      title: release.title,
      artist: release.artist,
      coverUrl: release.coverUrl,
      published: releaseData.published,
      approved: releaseData.approved,
      status: releaseData.status,
      releaseDate: release.releaseDate,
      updatedAt: releaseData.updatedAt,
      storage: 'r2'
    };

    if (existingIndex >= 0) {
      // Update existing entry
      releasesList[existingIndex] = releaseSummary;
      logger.info(`[Master JSON] Updated existing release in master list`);
    } else {
      // Add new entry
      releasesList.push(releaseSummary);
      logger.info(`[Master JSON] Added new release to master list`);
    }

    // Update master list
    await setDocument('system', 'releases-master', {
      releases: releasesList,
      totalReleases: releasesList.length,
      lastUpdated: new Date().toISOString()
    });

    logger.info(`[Master JSON] Master list updated (${releasesList.length} total releases)`);

    return new Response(JSON.stringify({
      success: true,
      releaseId: release.id,
      status: releaseData.status,
      published: releaseData.published,
      approved: releaseData.approved,
      totalReleases: releasesList.length,
      message: 'Release added to Firebase - PENDING APPROVAL'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[Master JSON] Error:', message);
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET endpoint to retrieve all releases
export const GET: APIRoute = async () => {
  try {
    const masterListDoc = await getDocument('system', 'releases-master') as Record<string, unknown> | null;

    if (!masterListDoc) {
      return new Response(JSON.stringify({
        releases: [],
        totalReleases: 0
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      releases: masterListDoc.releases || [],
      totalReleases: masterListDoc.totalReleases || 0,
      lastUpdated: masterListDoc.lastUpdated
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[Master JSON] GET Error:', message);
    return new Response(JSON.stringify({
      error: 'Internal error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
