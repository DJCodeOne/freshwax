// src/pages/api/postcode-lookup.ts
// UK Postcode lookup using postcodes.io (FREE, no API key required)
// This validates postcodes and returns location data (city, county, region)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { errorResponse, ApiErrors, createLogger, fetchWithTimeout } from '../../lib/api-utils';

const PostcodeLookupSchema = z.object({
  postcode: z.string().min(1, 'Postcode is required').max(10).transform(val => val.trim().toUpperCase().replace(/\s+/g, '')),
});

const logger = createLogger('postcode-lookup');

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard (60 req/min)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`postcode-lookup:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const parsed = PostcodeLookupSchema.safeParse({ postcode: url.searchParams.get('postcode') ?? '' });
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const postcode = parsed.data.postcode;

  logger.info('[postcode-lookup] Cleaned:', postcode);

  // Validate UK postcode format (basic validation)
  const postcodeRegex = /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$/;
  if (!postcodeRegex.test(postcode)) {
    return ApiErrors.badRequest('Invalid UK postcode format');
  }
  
  try {
    // Call postcodes.io API (FREE, no authentication required!)
    const apiUrl = `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`;
    logger.info('[postcode-lookup] Calling postcodes.io:', apiUrl);
    
    const response = await fetchWithTimeout(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    }, 8000);
    
    logger.info('[postcode-lookup] API response status:', response.status);
    
    if (!response.ok) {
      if (response.status === 404) {
        return ApiErrors.notFound('Postcode not found. Please check and try again.');
      }
      throw new Error(`Postcodes.io error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 200 || !data.result) {
      return ApiErrors.notFound('Postcode not found');
    }
    
    const result = data.result;
    
    // Format the postcode nicely (e.g., "SW1A 1AA")
    const formattedPostcode = result.postcode;
    
    // Determine the city/town - postcodes.io doesn't have a direct "city" field
    // We use admin_district or region as the closest approximation
    let city = '';
    let county = '';
    
    // For London postcodes, use "London" as the city
    if (result.region === 'London') {
      city = 'London';
      county = result.admin_district || ''; // e.g., "Westminster", "Camden"
    } else {
      // For other areas, admin_district is typically the town/city
      city = result.admin_district || result.parish || '';
      county = result.admin_county || result.region || '';
    }
    
    // Build location data
    const locationData = {
      postcode: formattedPostcode,
      city: city,
      county: county,
      region: result.region || '',
      country: result.country || 'England',
      latitude: result.latitude,
      longitude: result.longitude,
      // Additional useful data
      admin_district: result.admin_district || '',
      admin_ward: result.admin_ward || '',
      parish: result.parish || '',
      parliamentary_constituency: result.parliamentary_constituency || ''
    };
    
    logger.info('[postcode-lookup] Returning location data:', locationData);
    
    return successResponse({ ...locationData,
      // Note to frontend: this API validates postcodes and returns location data
      // Individual street addresses are not available (requires paid Royal Mail PAF license)
      message: 'Postcode validated. Please enter your street address below.' });
    
  } catch (error: unknown) {
    logger.error('[postcode-lookup] Error:', error instanceof Error ? error.message : String(error));

    if (error instanceof Error && error.name === 'AbortError') {
      return errorResponse('Request timed out. Please try again.', 504);
    }

    return errorResponse('Failed to lookup postcode. Please try again.');
  }
};
