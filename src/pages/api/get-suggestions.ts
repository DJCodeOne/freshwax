// src/pages/api/get-suggestions.ts
// OPTIMIZED: Lightweight endpoint for "You Might Also Like" suggestions
// Returns only necessary fields for 8 suggestions instead of all releases

import type { APIRoute } from 'astro';
import { getLiveReleases, CACHE_TTL } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

export const prerender = false;

const logger = createLogger('get-suggestions');

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-suggestions:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const url = new URL(request.url);
    const currentId = url.searchParams.get('currentId') || '';
    const artist = url.searchParams.get('artist') || '';
    const label = url.searchParams.get('label') || '';
    const genre = url.searchParams.get('genre') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '8'), 12);

    logger.info('Fetching suggestions for:', { currentId, artist, label, genre });

    // Use cached releases - this is very efficient due to firebase-rest caching
    const releases = await getLiveReleases(40);
    
    if (!releases || releases.length === 0) {
      return successResponse({ suggestions: [],
        message: 'No releases available' }, 200, { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=600' } });
    }
    
    // Filter out current release and score the rest
    const artistLower = artist.toLowerCase();
    const labelLower = label.toLowerCase();
    const genreLower = genre.toLowerCase();
    
    const scoredReleases = releases
      .filter(r => r.id !== currentId)
      .map(release => {
        let score = 0;
        let matchType = '';
        
        // Same artist = highest priority
        if (artistLower && release.artistName?.toLowerCase() === artistLower) {
          score += 100;
          matchType = 'More from Artist';
        }
        
        // Same label = high priority
        const releaseLabel = (release.labelName || release.recordLabel || release.copyrightHolder || '').toLowerCase();
        if (labelLower && releaseLabel === labelLower) {
          score += 50;
          if (!matchType) matchType = 'Same Label';
        }
        
        // Same genre = medium priority
        if (genreLower && release.genre?.toLowerCase() === genreLower) {
          score += 25;
          if (!matchType) matchType = 'Similar Style';
        }
        
        // Recency bonus (newer releases get slight boost)
        const ageInDays = (Date.now() - new Date(release.releaseDate || 0).getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays < 30) score += 10;
        else if (ageInDays < 90) score += 5;
        
        // Rating bonus
        const rating = release.ratings?.average || 0;
        if (rating >= 4) score += 10;
        else if (rating >= 3) score += 5;
        
        return { release, score, matchType };
      })
      .filter(item => item.score > 0 || Math.random() > 0.5) // Include some random ones too
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    // Return only the fields needed for suggestion cards
    const suggestions = scoredReleases.map(({ release, matchType }) => ({
      id: release.id,
      releaseName: release.releaseName || 'Untitled',
      artistName: release.artistName || 'Unknown Artist',
      coverArtUrl: release.coverArtUrl || release.artworkUrl || '/place-holder.webp',
      pricePerSale: release.pricePerSale || (release.trackPrice * (release.tracks?.length || 1)) || 0,
      matchType
    }));
    
    logger.info('Returning', suggestions.length, 'suggestions');
    
    return successResponse({
      suggestions,
      total: suggestions.length
    }, 200, {
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=600' }
    });
    
  } catch (error: unknown) {
    logger.error('Error:', error);
    return ApiErrors.serverError('Failed to fetch suggestions');
  }
};
