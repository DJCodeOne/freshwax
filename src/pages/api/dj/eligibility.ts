import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Default requirements (can be overridden by admin settings)
const DEFAULT_REQUIREMENTS = {
  requiredMixes: 1,
  requiredLikes: 10,
  allowBypassRequests: true
};

// Get admin settings
async function getSettings() {
  try {
    const settings = await getDocument('system', 'admin-settings');
    if (settings) {
      return {
        requiredMixes: settings?.livestream?.requiredMixes ?? DEFAULT_REQUIREMENTS.requiredMixes,
        requiredLikes: settings?.livestream?.requiredLikes ?? DEFAULT_REQUIREMENTS.requiredLikes,
        allowBypassRequests: settings?.livestream?.allowBypassRequests ?? DEFAULT_REQUIREMENTS.allowBypassRequests
      };
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
  return DEFAULT_REQUIREMENTS;
}

export const GET: APIRoute = async ({ url, locals }) => {
  initFirebase(locals);
  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');

  try {
    // Check DJ eligibility
    if (action === 'checkEligibility' && uid) {
      const settings = await getSettings();

      // Check for bypass in djLobbyBypass collection first (publicly readable)
      const bypassDoc = await getDocument('djLobbyBypass', uid);
      if (bypassDoc) {
        return new Response(JSON.stringify({
          success: true,
          eligible: true,
          reason: 'bypass_granted',
          canAccessLobby: true,
          canBook: true,
          canGoLive: true
        }));
      }

      // Try to get user document (may fail if not authenticated)
      let userData: any = null;
      try {
        userData = await getDocument('users', uid);
      } catch (e) {
        // Users collection requires auth - this is ok, we'll check other criteria
      }

      // If already eligible via role, return true
      if (userData?.roles?.djEligible) {
        return new Response(JSON.stringify({
          success: true,
          eligible: true,
          reason: 'already_eligible',
          canAccessLobby: true,
          canBook: true,
          canGoLive: true
        }));
      }

      // If has bypass flag in user doc, return true
      if (userData?.['go-liveBypassed'] === true) {
        return new Response(JSON.stringify({
          success: true,
          eligible: true,
          reason: 'bypass_granted',
          canAccessLobby: true,
          canBook: true,
          canGoLive: true
        }));
      }

      // Check mix count and likes
      const mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: uid }]
      });

      let totalMixes = 0;
      let mixesWithEnoughLikes = 0;
      let highestLikes = 0;
      let mixProgress: any[] = [];

      mixes.forEach(mix => {
        totalMixes++;
        const likes = mix.likes || 0;
        highestLikes = Math.max(highestLikes, likes);
        
        if (likes >= settings.requiredLikes) {
          mixesWithEnoughLikes++;
        }

        mixProgress.push({
          id: mix.id,
          title: mix.title,
          likes: likes,
          meetsThreshold: likes >= settings.requiredLikes
        });
      });

      const meetsRequirements = totalMixes >= settings.requiredMixes && mixesWithEnoughLikes >= settings.requiredMixes;

      // Check bypass request status
      const bypassStatus = userData?.pendingRoles?.djBypass?.status || null;
      const hasPendingBypass = bypassStatus === 'pending';
      const bypassApproved = bypassStatus === 'approved';

      return new Response(JSON.stringify({
        success: true,
        eligible: meetsRequirements || bypassApproved,
        meetsRequirements,
        bypassApproved,
        hasPendingBypass,
        canRequestBypass: settings.allowBypassRequests && !hasPendingBypass && !bypassApproved && !meetsRequirements,
        requirements: {
          requiredMixes: settings.requiredMixes,
          requiredLikes: settings.requiredLikes
        },
        progress: {
          totalMixes,
          mixesWithEnoughLikes,
          highestLikes,
          mixes: mixProgress
        },
        canAccessLobby: meetsRequirements || bypassApproved,
        canBook: meetsRequirements || bypassApproved,
        canGoLive: meetsRequirements || bypassApproved
      }));
    }

    // Get requirements only
    if (action === 'getRequirements') {
      const settings = await getSettings();
      return new Response(JSON.stringify({
        success: true,
        requirements: settings
      }));
    }

    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action' 
    }), { status: 400 });

  } catch (error: any) {
    console.error('DJ Eligibility API GET error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const body = await request.json();
    const { action, uid, reason } = body;

    // Check and update eligibility (called after a mix gets likes)
    if (action === 'checkAndUpdate') {
      if (!uid) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing uid' 
        }), { status: 400 });
      }

      const settings = await getSettings();

      // Get user document
      const userData = await getDocument('users', uid);

      if (!userData) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found'
        }), { status: 404 });
      }
      
      // If already eligible, no action needed
      if (userData?.roles?.djEligible) {
        return new Response(JSON.stringify({
          success: true,
          eligible: true,
          updated: false,
          message: 'Already eligible'
        }));
      }

      // Check mix count and likes
      const mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: uid }]
      });

      let mixesWithEnoughLikes = 0;

      mixes.forEach(mix => {
        if ((mix.likes || 0) >= settings.requiredLikes) {
          mixesWithEnoughLikes++;
        }
      });

      const meetsRequirements = mixes.length >= settings.requiredMixes && mixesWithEnoughLikes >= settings.requiredMixes;

      if (meetsRequirements) {
        // Auto-grant DJ eligibility
        await updateDocument('users', uid, {
          'roles.djEligible': true,
          updatedAt: new Date()
        });

        // Create notification
        await addDocument('notifications', {
          userId: uid,
          type: 'dj_eligible',
          title: 'DJ Status Unlocked! 🎧',
          message: 'Congratulations! You now have access to the DJ Lobby and can book livestream slots.',
          read: false,
          createdAt: new Date()
        });

        return new Response(JSON.stringify({
          success: true,
          eligible: true,
          updated: true,
          message: 'DJ eligibility granted!'
        }));
      }

      return new Response(JSON.stringify({
        success: true,
        eligible: false,
        updated: false,
        progress: {
          mixesWithEnoughLikes,
          required: settings.requiredMixes
        }
      }));
    }

    // Request bypass
    if (action === 'requestBypass') {
      if (!uid) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing uid' 
        }), { status: 400 });
      }

      const settings = await getSettings();

      if (!settings.allowBypassRequests) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Bypass requests are currently disabled'
        }), { status: 400 });
      }

      const userData = await getDocument('users', uid);

      if (!userData) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found'
        }), { status: 404 });
      }

      // Check if already eligible
      if (userData?.roles?.djEligible) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Already DJ eligible' 
        }), { status: 400 });
      }

      // Check if already has pending request
      if (userData?.pendingRoles?.djBypass?.status === 'pending') {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Bypass request already pending' 
        }), { status: 400 });
      }

      // Submit bypass request
      await updateDocument('users', uid, {
        'pendingRoles.djBypass': {
          requestedAt: new Date(),
          status: 'pending',
          reason: reason || ''
        },
        updatedAt: new Date()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Bypass request submitted'
      }));
    }

    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action' 
    }), { status: 400 });

  } catch (error: any) {
    console.error('DJ Eligibility API POST error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { status: 500 });
  }
};
