// src/pages/api/check-dj-eligibility.ts
// Check if a DJ meets the requirements to go live:
// - Must have at least 1 DJ mix uploaded
// - At least one mix must have 10+ likes
// - OR have an admin-granted bypass
// - Also returns bypass request status
import type { APIRoute } from 'astro';
import { getDocument, queryCollection } from '../../lib/firebase-rest';

export const prerender = false;
const REQUIRED_LIKES = 10;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  
  if (!userId) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Missing userId parameter' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  log.info('[check-dj-eligibility] Checking eligibility for:', userId);
  
  try {
    // First check if user is banned or on hold
    const moderation = await getDocument('djModeration', userId);

    if (moderation) {
      if (moderation.status === 'banned') {
        log.info('[check-dj-eligibility] User is banned');
        return new Response(JSON.stringify({
          success: true,
          eligible: false,
          reason: 'banned',
          message: 'Your account has been suspended from streaming.',
          bannedReason: moderation.reason || null
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (moderation.status === 'hold') {
        log.info('[check-dj-eligibility] User is on hold');
        return new Response(JSON.stringify({
          success: true,
          eligible: false,
          reason: 'on_hold',
          message: 'Your streaming access is temporarily on hold.',
          holdReason: moderation.reason || null
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Check if user has an admin-granted bypass (legacy collection)
    const bypass = await getDocument('djLobbyBypass', userId);

    if (bypass) {
      log.info('[check-dj-eligibility] User has admin bypass (djLobbyBypass collection)');
      return new Response(JSON.stringify({
        success: true,
        eligible: true,
        bypassGranted: true,
        reason: bypass.reason || null,
        message: 'Access granted by admin'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if user has go-liveBypassed flag on their user document
    const userData = await getDocument('users', userId);
    if (userData) {
      if (userData['go-liveBypassed'] === true) {
        log.info('[check-dj-eligibility] User has go-live bypass flag on user doc');
        return new Response(JSON.stringify({ 
          success: true,
          eligible: true,
          bypassGranted: true,
          message: 'Access granted by admin'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Check for pending bypass request
    const bypassRequests = await queryCollection('bypassRequests', {
      filters: [
        { field: 'userId', op: 'EQUAL', value: userId },
        { field: 'status', op: 'EQUAL', value: 'pending' }
      ],
      limit: 1
    });

    let bypassRequest = null;
    if (bypassRequests.length > 0) {
      const reqData = bypassRequests[0];
      bypassRequest = {
        status: reqData.status,
        requestedAt: reqData.requestedAt || reqData.createdAt,
        denialReason: reqData.denialReason || null
      };
    }
    
    // Get all mixes for this user
    const mixes = await queryCollection('dj-mixes', {
      filters: [{ field: 'userId', op: 'EQUAL', value: userId }]
    });
    log.info('[check-dj-eligibility] Found', mixes.length, 'mixes for user');
    
    // Check if they have any mixes
    if (mixes.length === 0) {
      return new Response(JSON.stringify({ 
        success: true,
        eligible: false,
        reason: 'no_mixes',
        message: 'You need to upload at least one DJ mix to Fresh Wax before you can go live.',
        mixCount: 0,
        qualifyingMixes: 0,
        requiredLikes: REQUIRED_LIKES,
        bypassRequest
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if any mix has 10+ likes
    const qualifyingMixes = mixes.filter(mix => {
      const likes = mix.likeCount || mix.likes || 0;
      return likes >= REQUIRED_LIKES;
    });
    
    log.info('[check-dj-eligibility] Qualifying mixes (10+ likes):', qualifyingMixes.length);
    
    if (qualifyingMixes.length === 0) {
      // Find the mix with the most likes to show progress
      const bestMix = mixes.reduce((best, current) => {
        const currentLikes = current.likeCount || current.likes || 0;
        const bestLikes = best.likeCount || best.likes || 0;
        return currentLikes > bestLikes ? current : best;
      }, mixes[0]);
      
      const bestLikes = bestMix.likeCount || bestMix.likes || 0;
      
      return new Response(JSON.stringify({ 
        success: true,
        eligible: false,
        reason: 'insufficient_likes',
        message: `Your mixes need at least ${REQUIRED_LIKES} likes to go live. Your best mix has ${bestLikes} like${bestLikes === 1 ? '' : 's'}.`,
        mixCount: mixes.length,
        qualifyingMixes: 0,
        bestMixLikes: bestLikes,
        requiredLikes: REQUIRED_LIKES,
        likesNeeded: REQUIRED_LIKES - bestLikes,
        bypassRequest
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // DJ is eligible!
    return new Response(JSON.stringify({ 
      success: true,
      eligible: true,
      mixCount: mixes.length,
      qualifyingMixes: qualifyingMixes.length,
      requiredLikes: REQUIRED_LIKES
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    log.error('[check-dj-eligibility] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message || 'Failed to check eligibility'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
