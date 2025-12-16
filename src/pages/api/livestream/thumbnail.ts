// src/pages/api/livestream/thumbnail.ts
// Returns a dynamic thumbnail for social media sharing
// When live: redirects to the DJ's cover image or avatar
// When offline: redirects to default live page image
import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';

// Cache for stream status
let cachedStatus: { isLive: boolean; imageUrl: string; timestamp: number } | null = null;
const CACHE_TTL = 30 * 1000; // 30 seconds

export const GET: APIRoute = async ({ request }) => {
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

    let imageUrl = '/og-image.jpg'; // Default site image when offline
    let isLive = false;

    if (liveSlots.length > 0) {
      const liveStream = liveSlots[0];
      isLive = true;

      // Priority: cover image > DJ avatar > logo
      if (liveStream.coverImage && liveStream.coverImage !== '/placeholder.webp' && !liveStream.coverImage.includes('placeholder')) {
        imageUrl = liveStream.coverImage;
      } else if (liveStream.djAvatar && liveStream.djAvatar !== '/placeholder.webp' && !liveStream.djAvatar.includes('placeholder')) {
        imageUrl = liveStream.djAvatar;
      } else {
        imageUrl = '/logo.webp'; // Branded Fresh Wax logo
      }
    }

    // Update cache
    cachedStatus = { isLive, imageUrl, timestamp: Date.now() };

    return redirectToImage(imageUrl);

  } catch (error) {
    console.error('[livestream/thumbnail] Error:', error);
    // Return default image on error
    return redirectToImage('/og-image.jpg');
  }
};

function redirectToImage(imageUrl: string): Response {
  // If it's a relative URL, make it absolute
  const fullUrl = imageUrl.startsWith('http')
    ? imageUrl
    : `https://freshwax.co.uk${imageUrl}`;

  // Use 302 redirect so crawlers always get fresh content
  return new Response(null, {
    status: 302,
    headers: {
      'Location': fullUrl,
      'Cache-Control': 'public, max-age=30, s-maxage=60',
    }
  });
}
