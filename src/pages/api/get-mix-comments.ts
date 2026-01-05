// src/pages/api/get-mix-comments.ts
// Uses D1 first, Firebase fallback
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';
import { d1GetComments } from '../../lib/d1-catalog';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  try {
    const url = new URL(request.url);
    const mixId = url.searchParams.get('mixId');

    if (!mixId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try D1 first
    if (db) {
      try {
        const comments = await d1GetComments(db, mixId, 'mix');
        if (comments.length > 0) {
          log.info(`[get-mix-comments] D1: Mix ${mixId}, Comments: ${comments.length}`);
          return new Response(JSON.stringify({
            success: true,
            comments,
            count: comments.length,
            source: 'd1'
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=60'
            }
          });
        }
      } catch (d1Error) {
        log.error('[get-mix-comments] D1 error, falling back to Firebase:', d1Error);
      }
    }

    // Fallback to Firebase
    const data = await getDocument('dj-mixes', mixId);

    if (!data) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const comments = data?.comments || [];

    log.info(`[get-mix-comments] Firebase: Mix ${mixId}, Comments: ${comments.length}`);

    return new Response(JSON.stringify({
      success: true,
      comments,
      count: comments.length,
      source: 'firebase'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60'
      }
    });

  } catch (error) {
    log.error('[get-mix-comments] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch comments'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
