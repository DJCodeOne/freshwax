// src/pages/api/get-comments.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
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

    console.log(`[get-comments] Fetching comments for: ${releaseId}`);

    // Fetch release document using REST API
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

    // Get comments array from release
    const comments = release.comments || [];
    
    // Sort by timestamp (newest first)
    const sortedComments = [...comments].sort((a: any, b: any) => {
      const dateA = new Date(a.timestamp || a.createdAt || 0).getTime();
      const dateB = new Date(b.timestamp || b.createdAt || 0).getTime();
      return dateB - dateA;
    });

    console.log(`[get-comments] ✓ Found ${sortedComments.length} comments for ${releaseId}`);

    return new Response(JSON.stringify({
      success: true,
      comments: sortedComments,
      count: sortedComments.length,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    });

  } catch (error) {
    console.error('[get-comments] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch comments'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};