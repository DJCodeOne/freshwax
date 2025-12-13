// src/pages/api/check-duplicates.ts
// OPTIMIZED: Shares ownership cache with check-ownership.ts
// Check if cart items are duplicates of previous purchases

import type { APIRoute } from 'astro';
import { adminDb as db } from '../../lib/firebase-admin';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

// Server-side cache for ownership data - shared pattern with check-ownership
const ownershipCache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getOwnershipData(userId: string): Promise<{ 
  ownedReleases: Set<string>; 
  ownedTracks: Map<string, Set<string>> 
}> {
  // Check cache first
  const cached = ownershipCache.get(userId);
  if (cached && Date.now() < cached.expires) {
    log.info('[check-duplicates] Using cached ownership data for', userId);
    return cached.data;
  }
  
  // Query orders for this customer
  const ordersRef = db.collection('orders');
  const ordersSnap = await ordersRef.where('customer.userId', '==', userId).get();
  
  const ownedReleases = new Set<string>();
  const ownedTracks = new Map<string, Set<string>>();
  
  ordersSnap.forEach(doc => {
    const order = doc.data();
    if (order.items && Array.isArray(order.items)) {
      order.items.forEach((item: any) => {
        const itemType = item.type || item.productType;
        const releaseId = item.releaseId || item.productId || item.id;
        
        // Skip non-audio items
        if (itemType === 'merch') return;
        
        if (itemType === 'digital' || itemType === 'release' || itemType === 'vinyl') {
          // Full release purchase (vinyl includes digital) - they own all tracks
          ownedReleases.add(releaseId);
        } else if (itemType === 'track' && item.trackId) {
          // Single track purchase
          if (!ownedTracks.has(releaseId)) {
            ownedTracks.set(releaseId, new Set());
          }
          ownedTracks.get(releaseId)!.add(item.trackId);
        }
      });
    }
  });
  
  const data = { ownedReleases, ownedTracks };
  
  // Cache the result
  ownershipCache.set(userId, { data, expires: Date.now() + CACHE_TTL });
  
  return data;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { userId, cartItems } = await request.json();
    
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!cartItems || !Array.isArray(cartItems)) {
      return new Response(JSON.stringify({ duplicates: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get cached ownership data
    const { ownedReleases, ownedTracks } = await getOwnershipData(userId);
    
    // Check cart items for duplicates
    const duplicates: any[] = [];
    
    for (const item of cartItems) {
      const itemType = item.type || item.productType;
      const releaseId = item.releaseId || item.productId || item.id;
      
      // Skip merch - can buy duplicates
      if (itemType === 'merch') continue;
      
      if (itemType === 'digital' || itemType === 'release') {
        // Trying to buy a full release they already own
        if (ownedReleases.has(releaseId)) {
          duplicates.push({
            item,
            reason: 'You already own this release'
          });
        }
      } else if (itemType === 'vinyl') {
        // Vinyl is fine even if they own digital - they might want physical
      } else if (itemType === 'track') {
        // Check if they own the full release (which includes this track)
        if (ownedReleases.has(releaseId)) {
          duplicates.push({
            item,
            reason: 'You already own the full release that includes this track'
          });
        }
        // Or check if they already bought this specific track
        else if (item.trackId && ownedTracks.has(releaseId) && ownedTracks.get(releaseId)!.has(item.trackId)) {
          duplicates.push({
            item,
            reason: 'You already own this track'
          });
        }
      }
    }
    
    log.info('[check-duplicates] User:', userId, 'Owned releases:', ownedReleases.size, 'Duplicates found:', duplicates.length);
    
    return new Response(JSON.stringify({ 
      duplicates,
      ownedReleases: [...ownedReleases]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[check-duplicates] Error:', error);
    return new Response(JSON.stringify({ error: 'Failed to check duplicates' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
