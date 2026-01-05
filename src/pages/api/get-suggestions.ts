// src/pages/api/get-suggestions.ts
// OPTIMIZED: Lightweight endpoint for "You Might Also Like" suggestions
// Returns only necessary fields for 8 suggestions instead of all releases

import type { APIRoute } from 'astro';
import { getLiveReleases, CACHE_TTL } from '../../lib/firebase-rest';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log('[get-suggestions]', ...args),
  error: (...args: any[]) => console.error('[get-suggestions]', ...args),
};

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const url = new URL(request.url);
    const currentId = url.searchParams.get('currentId') || '';
    const artist = url.searchParams.get('artist') || '';
    const label = url.searchParams.get('label') || '';
    const genre = url.searchParams.get('genre') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '8'), 12);

    log.info('Fetching suggestions for:', { currentId, artist, label, genre });

    // Get D1 binding for optimized reads
    const db = (locals as any)?.runtime?.env?.DB;

    // Use cached releases - this is very efficient due to firebase-rest caching
    const releases = await getLiveReleases(40, db); // Only fetch 40, not all
    
    if (!releases || releases.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        suggestions: [],
        message: 'No releases available'
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=600'
        }
      });
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
    
    log.info('Returning', suggestions.length, 'suggestions');
    
    return new Response(JSON.stringify({ 
      success: true,
      suggestions,
      total: suggestions.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=600' // 10 min edge cache
      }
    });
    
  } catch (error) {
    log.error('Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch suggestions',
      suggestions: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
