// src/pages/api/icecast-auth.ts
// Icecast URL-based authentication for BUTT connections
// Validates that the source password matches the current DJ's stream key

import type { APIContext } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

// Icecast sends POST with form data for source authentication
export async function POST({ request, locals }: APIContext) {
  try {
    initEnv(locals);

    // Parse form data from Icecast
    const formData = await request.formData();
    const mount = formData.get('mount') as string;
    const user = formData.get('user') as string;
    const pass = formData.get('pass') as string;
    const ip = formData.get('ip') as string;
    const action = formData.get('action') as string; // 'source_auth' for source connections

    console.log('[Icecast Auth] Request:', { mount, user, action, ip, hasPass: !!pass });

    // Only handle source authentication
    if (action !== 'source_auth') {
      // Allow listener connections without auth
      return new Response('icecast-auth-user=1', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // The password should be the DJ's stream key
    const streamKey = pass;

    if (!streamKey || !streamKey.startsWith('fwx_')) {
      console.log('[Icecast Auth] Invalid stream key format');
      return new Response('Invalid stream key', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Find active/scheduled slot with this stream key
    const now = new Date();
    const slots = await queryCollection('livestreamSlots', {
      filters: [
        { field: 'streamKey', op: 'EQUAL', value: streamKey }
      ],
      limit: 1,
      skipCache: true
    });

    if (slots.length === 0) {
      console.log('[Icecast Auth] No slot found for stream key');
      return new Response('Stream key not found or expired', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const slot = slots[0];

    // Check slot status
    if (slot.status === 'cancelled' || slot.status === 'ended') {
      console.log('[Icecast Auth] Slot is cancelled or ended');
      return new Response('Slot has been cancelled or ended', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Check if slot time is valid (allow 10 min early, 5 min grace after end)
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);
    const earlyWindow = 10 * 60 * 1000; // 10 minutes early
    const graceWindow = 5 * 60 * 1000; // 5 minutes grace

    if (now.getTime() < slotStart.getTime() - earlyWindow) {
      const minsUntil = Math.ceil((slotStart.getTime() - now.getTime()) / 60000);
      console.log('[Icecast Auth] Too early, slot starts in', minsUntil, 'minutes');
      return new Response(`Too early - slot starts in ${minsUntil} minutes`, {
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    if (now.getTime() > slotEnd.getTime() + graceWindow) {
      console.log('[Icecast Auth] Slot has ended');
      return new Response('Slot has ended', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Authentication successful
    console.log('[Icecast Auth] SUCCESS - DJ:', slot.djName, 'Slot:', slot.id);

    // Return success with mount point info
    // Format: icecast-auth-user=1 means authenticated
    return new Response('icecast-auth-user=1', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'icecast-auth-user': '1',
        'icecast-auth-message': `Welcome ${slot.djName}!`
      }
    });

  } catch (error: any) {
    console.error('[Icecast Auth] Error:', error);
    return new Response('Authentication error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// GET endpoint for testing/status
export async function GET({ url, locals }: APIContext) {
  initEnv(locals);

  const streamKey = url.searchParams.get('key');

  if (!streamKey) {
    return new Response(JSON.stringify({
      success: true,
      message: 'Icecast authentication endpoint active',
      usage: 'POST with form data: mount, user, pass (stream key), action'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Test a stream key
  try {
    const slots = await queryCollection('livestreamSlots', {
      filters: [
        { field: 'streamKey', op: 'EQUAL', value: streamKey }
      ],
      limit: 1,
      skipCache: true
    });

    if (slots.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        valid: false,
        error: 'Stream key not found'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const slot = slots[0];
    const now = new Date();
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);

    return new Response(JSON.stringify({
      success: true,
      valid: true,
      djName: slot.djName,
      status: slot.status,
      startTime: slot.startTime,
      endTime: slot.endTime,
      canConnect: now >= new Date(slotStart.getTime() - 10 * 60 * 1000) &&
                  now <= new Date(slotEnd.getTime() + 5 * 60 * 1000)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
