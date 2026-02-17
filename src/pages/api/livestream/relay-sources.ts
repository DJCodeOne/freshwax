// src/pages/api/livestream/relay-sources.ts
// API for managing external radio relay sources
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

// GET - List all relay sources or check specific one
export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`relay-sources:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  try {
    const url = new URL(request.url);
    const sourceId = url.searchParams.get('id');
    
    if (sourceId) {
      // Get single source
      const doc = await getDocument('relaySources', sourceId);
      if (!doc) {
        return ApiErrors.notFound('Source not found');
      }
      return new Response(JSON.stringify({ success: true, source: doc }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List all sources
    const sources = await queryCollection('relaySources', {
      orderBy: { field: 'name', direction: 'ASCENDING' }
    });
    
    return new Response(JSON.stringify({ success: true, sources }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Error fetching relay sources:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// POST - Create new relay source (admin only)
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId2 = getClientId(request);
  const rateLimit2 = checkRateLimit(`relay-sources-create:${clientId2}`, RateLimiters.standard);
  if (!rateLimit2.allowed) {
    return rateLimitResponse(rateLimit2.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  try {
    const data = await request.json();
    
    const { name, streamUrl, websiteUrl, logoUrl, genre, description, checkMethod, statusUrl } = data;
    
    if (!name || !streamUrl) {
      return ApiErrors.badRequest('Name and stream URL are required');
    }
    
    const now = new Date().toISOString();
    const sourceData = {
      name,
      streamUrl,
      websiteUrl: websiteUrl || '',
      logoUrl: logoUrl || '',
      genre: genre || 'Jungle / D&B',
      description: description || '',
      checkMethod: checkMethod || 'none', // 'none', 'http', 'icecast'
      statusUrl: statusUrl || '',
      active: true,
      isCurrentlyLive: false,
      lastChecked: null,
      nowPlaying: '',
      createdAt: now,
      updatedAt: now
    };

    const { id } = await addDocument('relaySources', sourceData);

    return new Response(JSON.stringify({
      success: true,
      id,
      source: { id, ...sourceData }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Error creating relay source:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// PUT - Update relay source (admin only)
export const PUT: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId3 = getClientId(request);
  const rateLimit3 = checkRateLimit(`relay-sources-update:${clientId3}`, RateLimiters.standard);
  if (!rateLimit3.allowed) {
    return rateLimitResponse(rateLimit3.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  try {
    const data = await request.json();
    const { id, ...updates } = data;
    
    if (!id) {
      return ApiErrors.badRequest('Source ID is required');
    }
    
    // Remove fields that shouldn't be updated directly
    delete updates.createdAt;
    updates.updatedAt = new Date().toISOString();

    await updateDocument('relaySources', id, updates);
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Error updating relay source:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// DELETE - Remove relay source (admin only)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId4 = getClientId(request);
  const rateLimit4 = checkRateLimit(`relay-sources-delete:${clientId4}`, RateLimiters.standard);
  if (!rateLimit4.allowed) {
    return rateLimitResponse(rateLimit4.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    
    if (!id) {
      return ApiErrors.badRequest('Source ID is required');
    }
    
    await deleteDocument('relaySources', id);
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Error deleting relay source:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
