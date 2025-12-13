// src/pages/api/get-mix-comments.ts
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request }) => {
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

    log.info(`[get-mix-comments] Mix: ${mixId}, Comments: ${comments.length}`);

    return new Response(JSON.stringify({
      success: true,
      comments: comments,
      count: comments.length
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60' // 1 minute cache
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
