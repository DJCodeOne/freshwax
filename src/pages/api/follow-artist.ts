// src/pages/api/follow-artist.ts
// Follow/unfollow artists API

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
    
    // Get user's followed artists
    const customerDoc = await db.collection('customers').doc(userId).get();
    const followedArtists = customerDoc.exists ? (customerDoc.data()?.followedArtists || []) : [];
    
    // If has followed artists, fetch their info
    if (followedArtists.length > 0) {
      const artistsData: any[] = [];
      
      // Get artist info from releases (grouped by artistName)
      const releasesSnapshot = await db.collection('releases')
        .where('status', '==', 'approved')
        .limit(500)
        .get();
      
      // Build a map of artists and their release counts
      const artistMap = new Map<string, any>();
      
      releasesSnapshot.docs.forEach(doc => {
        const release = doc.data();
        const artistName = release.artistName;
        const artistId = release.artistId || release.submittedBy;
        
        if (followedArtists.includes(artistName) || followedArtists.includes(artistId)) {
          const key = artistName || artistId;
          if (!artistMap.has(key)) {
            artistMap.set(key, {
              id: artistId || key,
              artistName: artistName,
              releaseCount: 0,
              latestRelease: null,
              latestReleaseDate: null,
              coverArtUrl: release.coverArtUrl
            });
          }
          
          const artist = artistMap.get(key);
          artist.releaseCount++;
          
          // Track latest release
          const releaseDate = release.releaseDate || release.publishedAt || release.createdAt;
          if (!artist.latestReleaseDate || releaseDate > artist.latestReleaseDate) {
            artist.latestReleaseDate = releaseDate;
            artist.latestRelease = {
              id: doc.id,
              releaseName: release.releaseName,
              coverArtUrl: release.coverArtUrl
            };
            artist.coverArtUrl = release.coverArtUrl;
          }
        }
      });
      
      // Convert map to array
      artistMap.forEach(artist => {
        artistsData.push(artist);
      });
      
      // Sort by latest release date
      artistsData.sort((a, b) => {
        const dateA = a.latestReleaseDate || '';
        const dateB = b.latestReleaseDate || '';
        return dateB.localeCompare(dateA);
      });
      
      return new Response(JSON.stringify({ 
        success: true, 
        followedArtists: artistsData,
        count: followedArtists.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      followedArtists: [],
      count: 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[FOLLOW API] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message || 'Failed to get followed artists'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { userId, artistName, artistId, action } = body;
    
    // Use artistName as the primary identifier, fall back to artistId
    const artistIdentifier = artistName || artistId;
    
    if (!userId || !artistIdentifier) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'User ID and Artist name/ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const db = getFirebaseAdmin();
    const customerRef = db.collection('customers').doc(userId);
    
    if (action === 'follow') {
      await customerRef.set({
        followedArtists: FieldValue.arrayUnion(artistIdentifier),
        followedArtistsUpdatedAt: new Date().toISOString()
      }, { merge: true });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Now following artist',
        isFollowing: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'unfollow') {
      await customerRef.update({
        followedArtists: FieldValue.arrayRemove(artistIdentifier),
        followedArtistsUpdatedAt: new Date().toISOString()
      });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Unfollowed artist',
        isFollowing: false
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'toggle') {
      const customerDoc = await customerRef.get();
      const currentFollowed = customerDoc.exists ? (customerDoc.data()?.followedArtists || []) : [];
      const isFollowing = currentFollowed.includes(artistIdentifier);
      
      if (isFollowing) {
        await customerRef.update({
          followedArtists: FieldValue.arrayRemove(artistIdentifier),
          followedArtistsUpdatedAt: new Date().toISOString()
        });
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Unfollowed artist',
          isFollowing: false
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await customerRef.set({
          followedArtists: FieldValue.arrayUnion(artistIdentifier),
          followedArtistsUpdatedAt: new Date().toISOString()
        }, { merge: true });
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Now following artist',
          isFollowing: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
    } else if (action === 'check') {
      const customerDoc = await customerRef.get();
      const currentFollowed = customerDoc.exists ? (customerDoc.data()?.followedArtists || []) : [];
      const isFollowing = currentFollowed.includes(artistIdentifier);
      
      return new Response(JSON.stringify({ 
        success: true, 
        isFollowing: isFollowing
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action. Use: follow, unfollow, toggle, or check' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[FOLLOW API] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message || 'Failed to update follow status'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
