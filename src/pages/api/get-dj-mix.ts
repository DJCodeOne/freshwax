// src/pages/api/get-dj-mix.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { getDocument, clearCache } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const logger = createLogger('get-dj-mix');

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-dj-mix:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const mixId = url.searchParams.get('id');
  const noCache = url.searchParams.get('nocache'); // Bypass cache if present
  
  if (!mixId) {
    return ApiErrors.badRequest('Mix ID required');
  }
  
  logger.info('[get-dj-mix] Fetching mix:', mixId, noCache ? '(nocache)' : '');
  
  // Clear cache for this mix if nocache requested
  if (noCache) {
    clearCache(`doc:dj-mixes:${mixId}`);
  }
  
  try {
    const mix = await getDocument('dj-mixes', mixId);
    
    if (!mix) {
      logger.info('[get-dj-mix] Not found:', mixId);
      return ApiErrors.notFound('Mix not found');
    }
    
    const normalized = {
      id: mix.id,
      title: mix.title || mix.name || 'Untitled Mix',
      artist: mix.displayName || mix.artist || mix.djName || mix.dj_name || 'Unknown DJ',
      artwork: mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/place-holder.webp',
      audioUrl: mix.audioUrl || mix.mp3Url || mix.streamUrl || null,
      duration: mix.duration || null,
      genre: mix.genre || mix.genres || [],
      description: mix.description || '',
      tracklist: mix.tracklist || [],
      playCount: mix.playCount || mix.plays || 0,
      likeCount: mix.likeCount || mix.likes || 0,
      downloadCount: mix.downloadCount || mix.downloads || 0,
      uploadedAt: mix.uploadedAt || mix.createdAt || null,
      allowDownload: mix.allowDownload !== false,
      // Include displayName and dj_name explicitly for the frontend
      displayName: mix.displayName || mix.dj_name || mix.djName || 'Unknown DJ',
      dj_name: mix.displayName || mix.dj_name || mix.djName || 'Unknown DJ',
      ...mix
    };
    
    logger.info('[get-dj-mix] Returning:', normalized.title);
    
    return successResponse({ mix: normalized,
      source: 'firebase-rest' }, 200, { headers: { 'Cache-Control': 'private, max-age=60, must-revalidate' } });
    
  } catch (error: unknown) {
    logger.error('[get-dj-mix] Error:', error);
    return ApiErrors.serverError('Failed to fetch mix');
  }
};
