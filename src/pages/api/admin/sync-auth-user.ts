// src/pages/api/admin/sync-auth-user.ts
// Admin endpoint to sync a Firebase Auth user to the users collection
// Use when a user exists in Auth but not in Firestore

import type { APIRoute } from 'astro';
import { saSetDocument, saGetDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'auto',
      private_key: privateKey.replace(/\\n/g, '\n'),
      client_email: clientEmail,
      client_id: '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    });

    const body = await request.json();
    const { uid, email, displayName } = body;

    if (!uid || !email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: uid and email',
        usage: { uid: 'firebase-auth-uid', email: 'user@example.com', displayName: 'Optional Name' }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user already exists
    const existing = await saGetDocument(serviceAccountKey, projectId, 'users', uid);
    if (existing) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User already exists in Firestore',
        user: existing
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create user document
    const userData = {
      email: email,
      displayName: displayName || email.split('@')[0],
      fullName: displayName || '',
      roles: {
        customer: true,
        dj: true,
        artist: false,
        merchSupplier: false,
        vinylSeller: false,
        admin: false
      },
      permissions: {
        canBuy: true,
        canComment: true,
        canRate: true
      },
      approved: false,
      suspended: false,
      createdAt: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      syncedFromAuth: true,
      syncedAt: new Date().toISOString()
    };

    await saSetDocument(serviceAccountKey, projectId, 'users', uid, userData);

    return new Response(JSON.stringify({
      success: true,
      message: 'User synced to Firestore',
      user: { id: uid, ...userData }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[sync-auth-user] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
