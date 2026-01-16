// src/pages/api/get-release.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { getDocument, clearCache } from '../../lib/firebase-rest';
import { normalizeRelease } from '../../lib/releases';
import { isAdmin as checkIsAdmin, getAdminUids, initAdminEnv } from '../../lib/admin';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('id');
  const noCache = url.searchParams.get('nocache'); // Bypass cache if present

  // Check admin status from authenticated cookie (not query params - that's insecure)
  const adminId = cookies.get('adminId')?.value;
  const firebaseUid = cookies.get('firebaseUid')?.value;
  const adminUids = getAdminUids();
  const isAdminUser = adminId ? adminUids.includes(adminId) :
                      firebaseUid ? adminUids.includes(firebaseUid) : false;

  if (!releaseId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Release ID required'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  log.info('[get-release] Fetching:', releaseId, noCache ? '(nocache)' : '', isAdminUser ? '(admin)' : '');
  
  // Clear cache for this release if nocache requested
  if (noCache) {
    clearCache(`doc:releases:${releaseId}`);
  }
  
  try {
    const release = await getDocument('releases', releaseId);
    
    if (!release) {
      log.info('[get-release] Not found:', releaseId);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Only check status for public requests (non-admin)
    if (!isAdminUser && release.status !== 'live') {
      log.info('[get-release] Not live:', releaseId, release.status);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not available' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const normalized = normalizeRelease(release, releaseId);

    // Fetch artist bio from users collection if artistId exists
    let artistBio = '';
    if (normalized.artistId) {
      try {
        const userDoc = await getDocument('users', normalized.artistId);
        if (userDoc?.pendingRoles?.artist?.bio) {
          const bio = userDoc.pendingRoles.artist.bio.trim();
          // Skip placeholder/default bios
          const placeholderBios = [
            'electronic music / digital and vinyl',
            'electronic music digital and vinyl'
          ];
          if (!placeholderBios.includes(bio.toLowerCase())) {
            artistBio = bio;
          }
        }
      } catch (err) {
        log.info('[get-release] Could not fetch artist bio:', err);
      }
    }

    log.info('[get-release] Returning:', normalized.artistName, '-', normalized.releaseName, artistBio ? '(has bio)' : '(no bio)');

    return new Response(JSON.stringify({
      success: true,
      release: { ...normalized, artistBio },
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60, must-revalidate'
      }
    });
    
  } catch (error) {
    log.error('[get-release] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch release',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};