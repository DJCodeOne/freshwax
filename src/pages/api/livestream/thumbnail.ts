// src/pages/api/livestream/thumbnail.ts
// Returns a dynamic thumbnail for social media sharing
// When live: redirects to the DJ's cover image or avatar
// When offline: redirects to default live page image
import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { createLogger } from '../../../lib/api-utils';

const log = createLogger('livestream/thumbnail');

// Cache for stream status
let cachedStatus: { isLive: boolean; imageUrl: string; timestamp: number } | null = null;
const CACHE_TTL = 30 * 1000; // 30 seconds

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`livestream-thumbnail:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const skipCache = url.searchParams.get('fresh') === '1';

  // Check cache first
  if (!skipCache && cachedStatus && Date.now() - cachedStatus.timestamp < CACHE_TTL) {
    return redirectToImage(cachedStatus.imageUrl);
  }

  try {
    // Check for live streams
    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 1,
      skipCache: true
    });

    let imageUrl = '/og-image.webp'; // Default site image when offline
    let isLive = false;

    if (liveSlots.length > 0) {
      const liveStream = liveSlots[0];
      isLive = true;

      // Priority: cover image > DJ avatar > logo
      if (liveStream.coverImage && liveStream.coverImage !== '/place-holder.webp' && !liveStream.coverImage.includes('place-holder')) {
        imageUrl = liveStream.coverImage;
      } else if (liveStream.djAvatar && liveStream.djAvatar !== '/place-holder.webp' && !liveStream.djAvatar.includes('place-holder')) {
        imageUrl = liveStream.djAvatar;
      } else {
        imageUrl = '/logo.webp'; // Branded Fresh Wax logo
      }
    }

    // Update cache
    cachedStatus = { isLive, imageUrl, timestamp: Date.now() };

    return redirectToImage(imageUrl);

  } catch (error: unknown) {
    log.error('Error:', error);
    // Return default image on error
    return redirectToImage('/og-image.webp');
  }
};

function redirectToImage(imageUrl: string): Response {
  let fullUrl: string;
  if (imageUrl.startsWith('http')) {
    // Validate redirect target — prevent open redirect
    try {
      const parsed = new URL(imageUrl);
      const allowed = ['freshwax.co.uk', 'cdn.freshwax.co.uk', 'storage.googleapis.com'];
      if (allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
        fullUrl = imageUrl;
      } else {
        fullUrl = `${SITE_URL}/og-image.webp`;
      }
    } catch (e: unknown) {
      fullUrl = `${SITE_URL}/og-image.webp`;
    }
  } else {
    fullUrl = `${SITE_URL}${imageUrl}`;
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': fullUrl,
      'Cache-Control': 'public, max-age=30, s-maxage=60',
    }
  });
}
