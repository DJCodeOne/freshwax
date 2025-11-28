// src/pages/api/search-releases.ts
// OPTIMIZED: Uses a cached search index to minimize Firebase reads
// Instead of querying Firebase on every search, we build an index periodically

import type { APIRoute } from 'astro';
import { db } from '../../firebase/server';

// ============================================
// IN-MEMORY SEARCH INDEX (rebuilt periodically)
// ============================================
interface SearchItem {
  id: string;
  type: 'release' | 'mix' | 'merch';
  title: string;
  artist_name: string;
  artwork_url: string;
  format: string;
  price: number | null;
  searchText: string; // Pre-computed lowercase searchable text
}

let searchIndex: SearchItem[] = [];
let lastIndexBuild = 0;
const INDEX_TTL = 5 * 60 * 1000; // Rebuild index every 5 minutes
let indexBuildPromise: Promise<void> | null = null;

async function buildSearchIndex(): Promise<void> {
  const now = Date.now();
  
  // Return if index is still fresh
  if (searchIndex.length > 0 && (now - lastIndexBuild) < INDEX_TTL) {
    return;
  }
  
  // If already building, wait for it
  if (indexBuildPromise) {
    await indexBuildPromise;
    return;
  }
  
  console.log('[Search] Building search index...');
  
  indexBuildPromise = (async () => {
    try {
      const newIndex: SearchItem[] = [];
      
      // Fetch releases (1 query total, not per-search!)
      try {
        const releasesSnapshot = await db.collection('releases')
          .where('status', '==', 'live')
          .get();
        
        releasesSnapshot.forEach((doc) => {
          const data = doc.data();
          const trackTitles = (data.tracks || [])
            .map((t: any) => t.trackName || t.title || t.trackTitle || '')
            .join(' ');
          
          let formatDisplay = 'Digital';
          if (data.releaseType === 'vinyl' || data.vinylRelease) {
            formatDisplay = 'Vinyl';
          } else if (data.releaseType === 'both' || (data.hasVinyl && data.hasDigital)) {
            formatDisplay = 'Vinyl + Digital';
          }
          
          newIndex.push({
            id: doc.id,
            type: 'release',
            title: data.releaseName || data.title || 'Untitled',
            artist_name: data.artistName || data.artist_name || 'Unknown Artist',
            artwork_url: data.coverArtUrl || data.artwork_url || '/logo.webp',
            format: formatDisplay,
            price: data.pricing?.digital || data.pricePerSale || data.price || null,
            searchText: [
              data.artistName,
              data.releaseName,
              data.title,
              data.labelName,
              data.recordLabel,
              data.genre,
              data.labelCode,
              trackTitles
            ].filter(Boolean).join(' ').toLowerCase()
          });
        });
        
        console.log('[Search] Indexed', releasesSnapshot.size, 'releases');
      } catch (err) {
        console.error('[Search] Error indexing releases:', err);
      }
      
      // Fetch DJ mixes
      try {
        const mixesSnapshot = await db.collection('dj_mixes')
          .where('status', '==', 'published')
          .get();
        
        mixesSnapshot.forEach((doc) => {
          const data = doc.data();
          const djName = data.dj_name || data.djName || '';
          
          newIndex.push({
            id: doc.id,
            type: 'mix',
            title: data.title || 'Untitled Mix',
            artist_name: djName || 'Unknown DJ',
            artwork_url: data.artwork_url || data.artworkUrl || '/logo.webp',
            format: 'DJ Mix',
            price: null,
            searchText: [
              data.title,
              djName,
              data.genre,
              data.description
            ].filter(Boolean).join(' ').toLowerCase()
          });
        });
        
        console.log('[Search] Indexed', mixesSnapshot.size, 'mixes');
      } catch (err) {
        console.error('[Search] Error indexing mixes:', err);
      }
      
      // Fetch merch
      try {
        const merchSnapshot = await db.collection('merch')
          .where('published', '==', true)
          .get();
        
        merchSnapshot.forEach((doc) => {
          const data = doc.data();
          
          newIndex.push({
            id: doc.id,
            type: 'merch',
            title: data.title || data.name || 'Untitled',
            artist_name: data.brand || 'Fresh Wax',
            artwork_url: data.images?.[0] || data.image_url || '/logo.webp',
            format: data.category || 'Merch',
            price: data.price || null,
            searchText: [
              data.title,
              data.name,
              data.description,
              data.category,
              data.brand
            ].filter(Boolean).join(' ').toLowerCase()
          });
        });
        
        console.log('[Search] Indexed', merchSnapshot.size, 'merch items');
      } catch (err) {
        console.error('[Search] Error indexing merch:', err);
      }
      
      searchIndex = newIndex;
      lastIndexBuild = Date.now();
      console.log('[Search] Index built with', searchIndex.length, 'total items');
      
    } catch (error) {
      console.error('[Search] Index build failed:', error);
    } finally {
      indexBuildPromise = null;
    }
  })();
  
  await indexBuildPromise;
}

// ============================================
// SEARCH HANDLER - Uses cached index (NO Firebase reads!)
// ============================================
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.toLowerCase().trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '8'), 20);

  if (!query || query.length < 2) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Query must be at least 2 characters',
      results: []
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Ensure index is built (only hits Firebase if index is stale)
    await buildSearchIndex();
    
    // Search the in-memory index (FREE - no Firebase reads!)
    const queryTerms = query.split(/\s+/).filter(t => t.length >= 2);
    
    const results = searchIndex
      .map(item => {
        let score = 0;
        const title = item.title.toLowerCase();
        const artist = item.artist_name.toLowerCase();
        
        // Scoring algorithm
        for (const term of queryTerms) {
          // Exact title match
          if (title === term) score += 100;
          // Title starts with term
          else if (title.startsWith(term)) score += 50;
          // Title contains term
          else if (title.includes(term)) score += 20;
          
          // Artist exact match
          if (artist === term) score += 80;
          // Artist starts with term
          else if (artist.startsWith(term)) score += 40;
          // Artist contains term
          else if (artist.includes(term)) score += 15;
          
          // General searchText match
          if (item.searchText.includes(term)) score += 5;
        }
        
        return { ...item, relevance: score };
      })
      .filter(item => item.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map(({ searchText, relevance, ...item }) => item); // Remove internal fields

    console.log('[Search] Query:', query, '| Results:', results.length);

    return new Response(JSON.stringify({
      success: true,
      results,
      total: results.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60' // Browser cache for 1 min
      }
    });

  } catch (error) {
    console.error('[Search API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Search failed',
      results: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};