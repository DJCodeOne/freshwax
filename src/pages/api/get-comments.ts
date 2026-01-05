// src/pages/api/get-comments.ts
// Uses D1 first, Firebase fallback
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { d1GetComments } from '../../lib/d1-catalog';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  // Initialize Firebase for fallback
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const releaseId = url.searchParams.get('releaseId');

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[get-comments] Fetching comments for:', releaseId);

    // Try D1 first
    if (db) {
      try {
        const comments = await d1GetComments(db, releaseId, 'release');
        if (comments.length > 0) {
          log.info('[get-comments] D1: Found', comments.length, 'comments');
          return new Response(JSON.stringify({
            success: true,
            comments,
            count: comments.length,
            source: 'd1'
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=60, s-maxage=60'
            }
          });
        }
      } catch (d1Error) {
        log.error('[get-comments] D1 error, falling back to Firebase:', d1Error);
      }
    }

    // Fallback to Firebase
    const release = await getDocument('releases', releaseId);

    if (!release) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const comments = release.comments || [];

    const sortedComments = [...comments].sort((a: any, b: any) => {
      const dateA = new Date(a.timestamp || a.createdAt || 0).getTime();
      const dateB = new Date(b.timestamp || b.createdAt || 0).getTime();
      return dateB - dateA;
    });

    log.info('[get-comments] Firebase: Found', sortedComments.length, 'comments');

    return new Response(JSON.stringify({
      success: true,
      comments: sortedComments,
      count: sortedComments.length,
      source: 'firebase'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    });

  } catch (error) {
    log.error('[get-comments] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch comments'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};