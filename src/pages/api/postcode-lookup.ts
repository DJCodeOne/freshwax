// src/pages/api/postcode-lookup.ts
// UK Postcode lookup using postcodes.io (FREE, no API key required)
// This validates postcodes and returns location data (city, county, region)

import type { APIRoute } from 'astro';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const rawPostcode = url.searchParams.get('postcode')?.trim().toUpperCase() || '';
  // Remove all spaces for the API call
  const postcode = rawPostcode.replace(/\s+/g, '');
  
  log.info('[postcode-lookup] Raw input:', rawPostcode, 'Cleaned:', postcode);
  
  if (!postcode) {
    return new Response(JSON.stringify({ error: 'Postcode is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Validate UK postcode format (basic validation)
  const postcodeRegex = /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$/;
  if (!postcodeRegex.test(postcode)) {
    return new Response(JSON.stringify({ error: 'Invalid UK postcode format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    // Call postcodes.io API (FREE, no authentication required!)
    const apiUrl = `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`;
    log.info('[postcode-lookup] Calling postcodes.io:', apiUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    log.info('[postcode-lookup] API response status:', response.status);
    
    if (!response.ok) {
      if (response.status === 404) {
        return new Response(JSON.stringify({ error: 'Postcode not found. Please check and try again.' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error(`Postcodes.io error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.status !== 200 || !data.result) {
      return new Response(JSON.stringify({ error: 'Postcode not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
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
    
    log.info('[postcode-lookup] Returning location data:', locationData);
    
    return new Response(JSON.stringify({
      success: true,
      ...locationData,
      // Note to frontend: this API validates postcodes and returns location data
      // Individual street addresses are not available (requires paid Royal Mail PAF license)
      message: 'Postcode validated. Please enter your street address below.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    console.error('[postcode-lookup] Error:', error.message || error);
    
    if (error.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Request timed out. Please try again.' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ error: 'Failed to lookup postcode. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
