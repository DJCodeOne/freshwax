// src/pages/api/check-ownership.ts
// OPTIMIZED: Caches user ownership data to reduce Firebase reads
// Check if a customer already owns a release or track

import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';

export const prerender = false;

// Server-side cache for ownership data - keyed by userId
const ownershipCache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes - ownership doesn't change often

async function getOwnershipData(userId: string): Promise<{ 
  ownedReleases: Set<string>; 
  ownedTracks: Map<string, string[]> 
}> {
  // Check cache first
  const cached = ownershipCache.get(userId);
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }
  
  // Fetch orders and build ownership map
  const orders = await queryCollection('orders', {
    filters: [{ field: 'customer.userId', op: 'EQUAL', value: userId }]
  });

  const ownedReleases = new Set<string>();
  const ownedTracks = new Map<string, string[]>(); // releaseId -> trackIds[]

  orders.forEach(order => {
    if (order.items && Array.isArray(order.items)) {
      order.items.forEach((item: any) => {
        const itemReleaseId = item.releaseId || item.productId || item.id;
        const itemType = item.type || item.productType;
        
        if (itemReleaseId) {
          // Full release ownership
          if (itemType === 'digital' || itemType === 'vinyl' || itemType === 'release') {
            ownedReleases.add(itemReleaseId);
          }
          // Track ownership
          else if (itemType === 'track' && item.trackId) {
            const existingTracks = ownedTracks.get(itemReleaseId) || [];
            if (!existingTracks.includes(item.trackId)) {
              existingTracks.push(item.trackId);
              ownedTracks.set(itemReleaseId, existingTracks);
            }
          }
        }
      });
    }
  });
  
  const data = { ownedReleases, ownedTracks };
  
  // Cache the result
  ownershipCache.set(userId, { data, expires: Date.now() + CACHE_TTL });
  
  return data;
}

// Export function to clear cache when order is created
export function clearOwnershipCache(userId: string) {
  ownershipCache.delete(userId);
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const releaseId = url.searchParams.get('releaseId');
  const trackId = url.searchParams.get('trackId'); // Optional - for checking specific track
  
  if (!userId || !releaseId) {
    return new Response(JSON.stringify({ error: 'userId and releaseId are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const { ownedReleases, ownedTracks } = await getOwnershipData(userId);
    
    const ownsFullRelease = ownedReleases.has(releaseId);
    const ownedTrackIds = ownedTracks.get(releaseId) || [];
    const ownsTrack = trackId ? ownedTrackIds.includes(trackId) : null;
    
    return new Response(JSON.stringify({
      releaseId,
      trackId: trackId || null,
      ownsFullRelease,
      ownsTrack,
      ownedTrackIds
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300' // 5 min browser cache
      }
    });
    
  } catch (error) {
    console.error('[check-ownership] Error:', error);
    return new Response(JSON.stringify({ error: 'Failed to check ownership' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
