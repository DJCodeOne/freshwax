import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Default requirements (can be overridden by admin settings)
const DEFAULT_REQUIREMENTS = {
  requiredMixes: 1,
  requiredLikes: 10,
  allowBypassRequests: true
};

// Get admin settings
async function getSettings() {
  try {
    const settingsDoc = await db.collection('system').doc('admin-settings').get();
    if (settingsDoc.exists) {
      const settings = settingsDoc.data();
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

export const GET: APIRoute = async ({ url }) => {
  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');

  try {
    // Check DJ eligibility
    if (action === 'checkEligibility' && uid) {
      const settings = await getSettings();
      
      // Get user document
      const userDoc = await db.collection('users').doc(uid).get();
      const userData = userDoc.exists ? userDoc.data() : null;
      
      // If already eligible, return true
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

      // Check mix count and likes
      const mixesQuery = await db.collection('dj-mixes')
        .where('userId', '==', uid)
        .get();

      let totalMixes = 0;
      let mixesWithEnoughLikes = 0;
      let highestLikes = 0;
      let mixProgress: any[] = [];

      mixesQuery.forEach(doc => {
        const mix = doc.data();
        totalMixes++;
        const likes = mix.likes || 0;
        highestLikes = Math.max(highestLikes, likes);
        
        if (likes >= settings.requiredLikes) {
          mixesWithEnoughLikes++;
        }

        mixProgress.push({
          id: doc.id,
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

export const POST: APIRoute = async ({ request }) => {
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
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'User not found' 
        }), { status: 404 });
      }

      const userData = userDoc.data();
      
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
      const mixesQuery = await db.collection('dj-mixes')
        .where('userId', '==', uid)
        .get();

      let mixesWithEnoughLikes = 0;

      mixesQuery.forEach(doc => {
        const mix = doc.data();
        if ((mix.likes || 0) >= settings.requiredLikes) {
          mixesWithEnoughLikes++;
        }
      });

      const meetsRequirements = mixesQuery.size >= settings.requiredMixes && mixesWithEnoughLikes >= settings.requiredMixes;

      if (meetsRequirements) {
        // Auto-grant DJ eligibility
        await userRef.update({
          'roles.djEligible': true,
          updatedAt: FieldValue.serverTimestamp()
        });

        // Create notification
        await db.collection('notifications').add({
          userId: uid,
          type: 'dj_eligible',
          title: 'DJ Status Unlocked! 🎧',
          message: 'Congratulations! You now have access to the DJ Lobby and can book livestream slots.',
          read: false,
          createdAt: FieldValue.serverTimestamp()
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

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'User not found' 
        }), { status: 404 });
      }

      const userData = userDoc.data();

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
      await userRef.update({
        'pendingRoles.djBypass': {
          requestedAt: FieldValue.serverTimestamp(),
          status: 'pending',
          reason: reason || ''
        },
        updatedAt: FieldValue.serverTimestamp()
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
