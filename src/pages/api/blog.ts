// src/pages/api/blog.ts
// Public blog API - fetch published posts
// Uses KV caching to reduce Firebase reads

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet } from '../../lib/kv-cache';

export const prerender = false;

// Cache config for blog (10 min for listing, 5 min for single posts)
const BLOG_LIST_CACHE = { prefix: 'blog', ttl: 600 };
const BLOG_POST_CACHE = { prefix: 'blog', ttl: 300 };

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initKVCache(env);
}

export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get('slug');
    const category = url.searchParams.get('category');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const incrementViews = url.searchParams.get('view') === '1';
    const skipCache = url.searchParams.get('fresh') === '1';

    if (slug) {
      // Check cache for single post (but not if incrementing views)
      const postCacheKey = `post:${slug}`;
      if (!incrementViews && !skipCache) {
        const cached = await kvGet(postCacheKey, BLOG_POST_CACHE);
        if (cached) {
          return new Response(JSON.stringify(cached), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

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

      const result = { success: true, post };

      // Cache if not incrementing views
      if (!incrementViews) {
        kvSet(postCacheKey, result, BLOG_POST_CACHE);
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check cache for listing
    const listCacheKey = `list:${category || 'all'}:${limit}`;
    if (!skipCache) {
      const cached = await kvGet(listCacheKey, BLOG_LIST_CACHE);
      if (cached) {
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, s-maxage=300'
          }
        });
      }
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

    const result = { success: true, posts };

    // Cache listing
    kvSet(listCacheKey, result, BLOG_LIST_CACHE);

    return new Response(JSON.stringify(result), {
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
