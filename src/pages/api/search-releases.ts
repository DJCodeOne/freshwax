// src/pages/api/search-releases.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
// Note: Firebase REST API doesn't support full-text search, so we fetch and filter client-side
import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.toLowerCase().trim();
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 20;
  
  if (!query || query.length < 2) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Search query must be at least 2 characters' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  console.log(`[SEARCH-RELEASES] Searching for: "${query}"`);
  
  try {
    // Fetch all live releases (Firebase REST doesn't support text search)
    const allReleases = await queryCollection('releases', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }]
    });
    
    // Client-side search across multiple fields
    const searchFields = ['releaseName', 'artistName', 'label', 'labelName', 'recordLabel', 'catalogNumber'];
    
    const matchedReleases = allReleases.filter(release => {
      // Check main fields
      for (const field of searchFields) {
        const value = release[field];
        if (value && typeof value === 'string' && value.toLowerCase().includes(query)) {
          return true;
        }
      }
      
      // Check track names
      const tracks = release.tracks || [];
      for (const track of tracks) {
        const trackName = track.trackName || track.title || track.name;
        if (trackName && trackName.toLowerCase().includes(query)) {
          return true;
        }
      }
      
      // Check genres
      const genres = release.genres || release.genre || [];
      if (Array.isArray(genres)) {
        for (const genre of genres) {
          if (typeof genre === 'string' && genre.toLowerCase().includes(query)) {
            return true;
          }
        }
      }
      
      return false;
    });
    
    // Score and sort results by relevance
    const scoredResults = matchedReleases.map(release => {
      let score = 0;
      const releaseName = (release.releaseName || '').toLowerCase();
      const artistName = (release.artistName || '').toLowerCase();
      
      // Exact matches score highest
      if (releaseName === query) score += 100;
      if (artistName === query) score += 100;
      
      // Starts with query scores high
      if (releaseName.startsWith(query)) score += 50;
      if (artistName.startsWith(query)) score += 50;
      
      // Contains query scores lower
      if (releaseName.includes(query)) score += 20;
      if (artistName.includes(query)) score += 20;
      
      return { ...release, _searchScore: score };
    });
    
    // Sort by score, then by release date
    scoredResults.sort((a, b) => {
      if (b._searchScore !== a._searchScore) {
        return b._searchScore - a._searchScore;
      }
      const dateA = new Date(a.releaseDate || 0).getTime();
      const dateB = new Date(b.releaseDate || 0).getTime();
      return dateB - dateA;
    });
    
    // Remove score from output and apply limit
    const results = scoredResults
      .slice(0, limit)
      .map(({ _searchScore, ...release }) => release);
    
    console.log(`[SEARCH-RELEASES] ✓ Found ${matchedReleases.length} matches, returning ${results.length}`);
    
    return new Response(JSON.stringify({ 
      success: true,
      query,
      results,
      totalMatches: matchedReleases.length,
      returned: results.length,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=60' // Shorter cache for search
      }
    });
    
  } catch (error) {
    console.error('[SEARCH-RELEASES] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Search failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};