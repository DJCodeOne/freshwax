// src/pages/api/wishlist.ts
// Wishlist management API - add, remove, get wishlist items

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin
function getFirebaseAdmin() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}');
    initializeApp({
      credential: cert(serviceAccount)
    });
  }
  return getFirestore();
}

export const GET: APIRoute = async ({ request, url }) => {
  try {
    const userId = url.searchParams.get('userId');
    
    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const db = getFirebaseAdmin();
    
    // Get user's wishlist
    const customerDoc = await db.collection('customers').doc(userId).get();
    const wishlist = customerDoc.exists ? (customerDoc.data()?.wishlist || []) : [];
    
    // If wishlist has items, fetch release details
    if (wishlist.length > 0) {
      const releasesSnapshot = await db.collection('releases')
        .where('__name__', 'in', wishlist.slice(0, 10)) // Firestore limit
        .get();
      
      const releases = releasesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        addedToWishlist: wishlist.includes(doc.id)
      }));
      
      // For more than 10, do additional queries
      if (wishlist.length > 10) {
        for (let i = 10; i < wishlist.length; i += 10) {
          const batch = wishlist.slice(i, i + 10);
          const batchSnapshot = await db.collection('releases')
            .where('__name__', 'in', batch)
            .get();
          
          batchSnapshot.docs.forEach(doc => {
            releases.push({
              id: doc.id,
              ...doc.data(),
              addedToWishlist: true
            });
          });
        }
      }
      
      // Sort by wishlist order (most recently added first)
      releases.sort((a, b) => {
        return wishlist.indexOf(b.id) - wishlist.indexOf(a.id);
      });
      
      return new Response(JSON.stringify({ 
        success: true, 
        wishlist: releases,
        count: wishlist.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      wishlist: [],
      count: 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[WISHLIST API] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message || 'Failed to get wishlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { userId, releaseId, action } = body;
    
    if (!userId || !releaseId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'User ID and Release ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const db = getFirebaseAdmin();
    const customerRef = db.collection('customers').doc(userId);
    
    if (action === 'add') {
      // Add to wishlist (prepend so newest is first)
      await customerRef.set({
        wishlist: FieldValue.arrayUnion(releaseId),
        wishlistUpdatedAt: new Date().toISOString()
      }, { merge: true });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Added to wishlist',
        inWishlist: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'remove') {
      // Remove from wishlist
      await customerRef.update({
        wishlist: FieldValue.arrayRemove(releaseId),
        wishlistUpdatedAt: new Date().toISOString()
      });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Removed from wishlist',
        inWishlist: false
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'toggle') {
      // Toggle wishlist status
      const customerDoc = await customerRef.get();
      const currentWishlist = customerDoc.exists ? (customerDoc.data()?.wishlist || []) : [];
      const isInWishlist = currentWishlist.includes(releaseId);
      
      if (isInWishlist) {
        await customerRef.update({
          wishlist: FieldValue.arrayRemove(releaseId),
          wishlistUpdatedAt: new Date().toISOString()
        });
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Removed from wishlist',
          inWishlist: false
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await customerRef.set({
          wishlist: FieldValue.arrayUnion(releaseId),
          wishlistUpdatedAt: new Date().toISOString()
        }, { merge: true });
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Added to wishlist',
          inWishlist: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
    } else if (action === 'check') {
      // Check if item is in wishlist
      const customerDoc = await customerRef.get();
      const currentWishlist = customerDoc.exists ? (customerDoc.data()?.wishlist || []) : [];
      const isInWishlist = currentWishlist.includes(releaseId);
      
      return new Response(JSON.stringify({ 
        success: true, 
        inWishlist: isInWishlist
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action. Use: add, remove, toggle, or check' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[WISHLIST API] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message || 'Failed to update wishlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
