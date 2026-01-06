// src/pages/api/artist/update-shipping.ts
// Update artist's default vinyl shipping rates

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { artistId, vinylShippingUK, vinylShippingEU, vinylShippingIntl, vinylShipsFrom } = body;

    if (!artistId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate shipping rates (must be non-negative if provided)
    const validateRate = (rate: any, name: string) => {
      if (rate !== null && rate !== undefined) {
        const num = parseFloat(rate);
        if (isNaN(num) || num < 0) {
          throw new Error(`Invalid ${name} rate`);
        }
        return num;
      }
      return null;
    };

    const shippingUK = validateRate(vinylShippingUK, 'UK');
    const shippingEU = validateRate(vinylShippingEU, 'EU');
    const shippingIntl = validateRate(vinylShippingIntl, 'International');

    // Verify artist exists
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Build update object (only include non-null values)
    const updateData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };

    // Update or remove shipping rates
    if (shippingUK !== null) {
      updateData.vinylShippingUK = shippingUK;
    }
    if (shippingEU !== null) {
      updateData.vinylShippingEU = shippingEU;
    }
    if (shippingIntl !== null) {
      updateData.vinylShippingIntl = shippingIntl;
    }
    if (vinylShipsFrom) {
      updateData.vinylShipsFrom = vinylShipsFrom.trim();
    }

    await updateDocument('artists', artistId, updateData);

    console.log('[Artist] Updated shipping rates for:', artistId, updateData);

    return new Response(JSON.stringify({
      success: true,
      message: 'Shipping rates updated',
      data: {
        vinylShippingUK: shippingUK,
        vinylShippingEU: shippingEU,
        vinylShippingIntl: shippingIntl,
        vinylShipsFrom: vinylShipsFrom || null
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Artist] Update shipping error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to update shipping rates'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
