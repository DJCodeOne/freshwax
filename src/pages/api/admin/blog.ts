// src/pages/api/admin/blog.ts
// Blog post CRUD API for admin

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument, updateDocument, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';

export const prerender = false;

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - List all blog posts or get single post
export const GET: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const postId = url.searchParams.get('id');
    const status = url.searchParams.get('status'); // 'all', 'published', 'draft'
    const limit = parseInt(url.searchParams.get('limit') || '50');

    if (postId) {
      // Get single post
      const post = await getDocument('blog-posts', postId);
      if (!post) {
        return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, post: { id: postId, ...post } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List all posts
    const filters: any[] = [];
    if (status === 'published') {
      filters.push({ field: 'status', op: 'EQUAL', value: 'published' });
    } else if (status === 'draft') {
      filters.push({ field: 'status', op: 'EQUAL', value: 'draft' });
    }

    const posts = await queryCollection('blog-posts', {
      filters,
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit
    });

    return new Response(JSON.stringify({ success: true, posts }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[blog API] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Create new blog post
export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  initFirebase(locals);

  try {
    const data = body;
    const { title, slug, content, excerpt, featuredImage, category, tags, status, author, seoTitle, seoDescription } = data;

    if (!title) {
      return new Response(JSON.stringify({ success: false, error: 'Title is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate slug if not provided
    const postSlug = slug || title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

    const now = new Date().toISOString();
    const postId = `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const postData = {
      title,
      slug: postSlug,
      content: content || '',
      excerpt: excerpt || '',
      featuredImage: featuredImage || '',
      category: category || 'General',
      tags: tags || [],
      status: status || 'draft',
      author: author || 'Fresh Wax',
      seoTitle: seoTitle || title,
      seoDescription: seoDescription || excerpt || '',
      views: 0,
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null
    };

    await setDocument('blog-posts', postId, postData);

    return new Response(JSON.stringify({ success: true, postId, post: { id: postId, ...postData } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[blog API] Create error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// PUT - Update blog post
export const PUT: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  initFirebase(locals);

  try {
    const data = body;
    const { id, ...updateData } = data;

    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'Post ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check post exists
    const existing = await getDocument('blog-posts', id);
    if (!existing) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();
    updateData.updatedAt = now;

    // Set publishedAt if publishing for first time
    if (updateData.status === 'published' && !existing.publishedAt) {
      updateData.publishedAt = now;
    }

    await updateDocument('blog-posts', id, updateData);

    return new Response(JSON.stringify({ success: true, message: 'Post updated' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[blog API] Update error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE - Delete blog post
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const postId = url.searchParams.get('id');

    if (!postId) {
      return new Response(JSON.stringify({ success: false, error: 'Post ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await deleteDocument('blog-posts', postId);

    return new Response(JSON.stringify({ success: true, message: 'Post deleted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[blog API] Delete error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
