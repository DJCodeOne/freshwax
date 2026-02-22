// src/pages/api/admin/blog.ts
// Blog post CRUD API for admin

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, getDocument, setDocument, updateDocument, deleteDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/blog');
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const blogCreateSchema = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  featuredImage: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['draft', 'published']).optional(),
  author: z.string().optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  adminKey: z.string().optional(),
});

const blogUpdateSchema = z.object({
  id: z.string().min(1),
  adminKey: z.string().optional(),
}).passthrough();

export const prerender = false;

// GET - List all blog posts or get single post
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`blog:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;  const saQuery = getSaQuery(locals);

  try {
    const url = new URL(request.url);
    const postId = url.searchParams.get('id');
    const status = url.searchParams.get('status'); // 'all', 'published', 'draft'
    const limit = parseInt(url.searchParams.get('limit') || '50');

    if (postId) {
      // Get single post
      const post = await getDocument('blog-posts', postId);
      if (!post) {
        return ApiErrors.notFound('Post not found');
      }
      return new Response(JSON.stringify({ success: true, post: { id: postId, ...post } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List all posts
    const filters: { field: string; op: string; value: string }[] = [];
    if (status === 'published') {
      filters.push({ field: 'status', op: 'EQUAL', value: 'published' });
    } else if (status === 'draft') {
      filters.push({ field: 'status', op: 'EQUAL', value: 'draft' });
    }

    const posts = await saQuery('blog-posts', {
      filters,
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit
    });

    return new Response(JSON.stringify({ success: true, posts }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Internal error');
  }
};

// POST - Create new blog post
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`blog-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;
  try {
    const parsed = blogCreateSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { title, slug, content, excerpt, featuredImage, category, tags, status, author, seoTitle, seoDescription } = parsed.data;

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

  } catch (error: unknown) {
    log.error('Create error:', error);
    return ApiErrors.serverError('Internal error');
  }
};

// PUT - Update blog post
export const PUT: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`blog-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;
  try {
    const parsed = blogUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { id, ...updateData } = parsed.data;

    // Check post exists
    const existing = await getDocument('blog-posts', id);
    if (!existing) {
      return ApiErrors.notFound('Post not found');
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

  } catch (error: unknown) {
    log.error('Update error:', error);
    return ApiErrors.serverError('Internal error');
  }
};

// DELETE - Delete blog post
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`blog-delete:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;
  try {
    const url = new URL(request.url);
    const postId = url.searchParams.get('id');

    if (!postId) {
      return ApiErrors.badRequest('Post ID is required');
    }

    await deleteDocument('blog-posts', postId);

    return new Response(JSON.stringify({ success: true, message: 'Post deleted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Delete error:', error);
    return ApiErrors.serverError('Internal error');
  }
};
