// src/pages/api/blog.ts
// Public blog API - fetch published posts

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get('slug');
    const category = url.searchParams.get('category');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const incrementViews = url.searchParams.get('view') === '1';

    if (slug) {
      // Get single post by slug
      const posts = await queryCollection('blog-posts', {
        filters: [
          { field: 'slug', op: 'EQUAL', value: slug },
          { field: 'status', op: 'EQUAL', value: 'published' }
        ],
        limit: 1
      });

      if (!posts || posts.length === 0) {
        return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const post = posts[0];

      // Increment views if requested
      if (incrementViews && post.id) {
        try {
          await updateDocument('blog-posts', post.id, {
            views: (post.views || 0) + 1
          });
        } catch (e) {
          // Ignore view increment errors
        }
      }

      return new Response(JSON.stringify({ success: true, post }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List published posts
    const filters: any[] = [
      { field: 'status', op: 'EQUAL', value: 'published' }
    ];

    if (category && category !== 'all') {
      filters.push({ field: 'category', op: 'EQUAL', value: category });
    }

    const posts = await queryCollection('blog-posts', {
      filters,
      orderBy: { field: 'publishedAt', direction: 'DESCENDING' },
      limit
    });

    return new Response(JSON.stringify({ success: true, posts }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=300'
      }
    });

  } catch (error: any) {
    console.error('[public blog API] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
