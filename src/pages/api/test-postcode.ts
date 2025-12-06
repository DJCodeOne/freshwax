// src/pages/api/test-postcode.ts
// Test endpoint for getaddress.io API - for debugging

import type { APIRoute } from 'astro';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const testPostcode = 'SW1A1AA'; // Buckingham Palace
  const apiKey = import.meta.env.GETADDRESS_API_KEY || 'CHya2U_26EWbF92oxl0sdg49025';
  
  const results: Record<string, any> = {
    timestamp: new Date().toISOString(),
    testPostcode,
    apiKeyPresent: !!apiKey,
    apiKeyLength: apiKey?.length || 0,
    apiKeyPrefix: apiKey?.substring(0, 8) + '...',
  };
  
  try {
    // Test the API
    const apiUrl = `https://api.getaddress.io/find/${testPostcode}?api-key=${apiKey}&expand=true`;
    
    log.info('[test-postcode] Testing API with URL:', apiUrl.replace(apiKey, 'KEY_HIDDEN'));
    
    const startTime = Date.now();
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    });
    const endTime = Date.now();
    
    results.responseTime = `${endTime - startTime}ms`;
    results.status = response.status;
    results.statusText = response.statusText;
    results.headers = Object.fromEntries(response.headers.entries());
    
    const bodyText = await response.text();
    results.bodyLength = bodyText.length;
    
    if (response.ok) {
      try {
        const data = JSON.parse(bodyText);
        results.success = true;
        results.postcodeReturned = data.postcode;
        results.addressCount = data.addresses?.length || 0;
        results.sampleAddress = data.addresses?.[0] ? 
          (typeof data.addresses[0] === 'string' ? data.addresses[0].substring(0, 100) : JSON.stringify(data.addresses[0]).substring(0, 100)) 
          : null;
        results.latitude = data.latitude;
        results.longitude = data.longitude;
      } catch (e: any) {
        results.parseError = e.message;
        results.rawBody = bodyText.substring(0, 500);
      }
    } else {
      results.success = false;
      results.errorBody = bodyText.substring(0, 500);
      
      // Provide helpful error messages
      if (response.status === 401) {
        results.diagnosis = 'API key is invalid or expired. Please check your getaddress.io account.';
      } else if (response.status === 403) {
        results.diagnosis = 'API access forbidden. You may need to set up a Domain Token in your getaddress.io dashboard.';
      } else if (response.status === 429) {
        results.diagnosis = 'Rate limit exceeded. You have used all your free lookups for today.';
      } else if (response.status === 404) {
        results.diagnosis = 'Postcode not found (this should not happen for SW1A1AA).';
      }
    }
    
  } catch (error: any) {
    results.success = false;
    results.error = error.message || String(error);
    results.errorName = error.name;
    results.diagnosis = 'Network error - could not reach getaddress.io. This might be a temporary issue.';
  }
  
  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};