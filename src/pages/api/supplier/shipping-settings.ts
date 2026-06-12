// src/pages/api/supplier/shipping-settings.ts
// Merch supplier free-shipping settings (accessCode auth, same pattern as
// the supplier portal's payout endpoints). Suppliers can enable "free
// shipping over £X" — checkout waives the merch shipping charge when their
// items in a basket reach the threshold.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('supplier-shipping-settings');

export const prerender = false;

const PostSchema = z.object({
  accessCode: z.string().min(4),
  freeShippingEnabled: z.boolean(),
  freeShippingThreshold: z.number().min(0).max(1000),
}).strip();

async function findSupplierByAccessCode(accessCode: string): Promise<Record<string, unknown> | null> {
  const suppliers = await queryCollection('merch-suppliers', { limit: 100, skipCache: true });
  return suppliers.find((s: Record<string, unknown>) => s.accessCode === accessCode) || null;
}

export const GET: APIRoute = async ({ request, url }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`supplier-shipping-get:${clientId}`, { maxRequests: 30, windowMs: 60 * 1000 });
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfter!);

  const accessCode = url.searchParams.get('code') || '';
  if (accessCode.length < 4) return ApiErrors.badRequest('Access code required');

  try {
    const supplier = await findSupplierByAccessCode(accessCode);
    if (!supplier) return ApiErrors.notFound('Supplier not found');

    return successResponse({
      freeShippingEnabled: supplier.freeShippingEnabled === true,
      freeShippingThreshold: typeof supplier.freeShippingThreshold === 'number' ? supplier.freeShippingThreshold : 0,
    }, 200, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    log.error('GET error:', error);
    return ApiErrors.serverError('Failed to load settings');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`supplier-shipping-post:${clientId}`, { maxRequests: 10, windowMs: 60 * 60 * 1000 });
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfter!);

  try {
    const body = await request.json();
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) return ApiErrors.badRequest('Invalid request');

    const { accessCode, freeShippingEnabled, freeShippingThreshold } = parsed.data;

    const supplier = await findSupplierByAccessCode(accessCode);
    if (!supplier || !supplier.id) return ApiErrors.notFound('Supplier not found');

    await updateDocument('merch-suppliers', supplier.id as string, {
      freeShippingEnabled,
      freeShippingThreshold: Math.round(freeShippingThreshold * 100) / 100,
      updatedAt: new Date().toISOString(),
    });

    log.info('Updated free-shipping settings for supplier:', supplier.id);
    return successResponse({ message: 'Shipping settings saved' });
  } catch (error: unknown) {
    log.error('POST error:', error);
    return ApiErrors.serverError('Failed to save settings');
  }
};
