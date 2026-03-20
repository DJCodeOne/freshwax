// src/pages/api/livestream/check-relays.ts
// API to check if external radio streams are live
import type { APIRoute } from 'astro';
import { updateDocument, queryCollection } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { requireAdminAuth } from '../../../lib/admin';
import { ApiErrors, fetchWithTimeout, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('livestream/check-relays');

export const prerender = false;

interface RelayStatus {
  id: string;
  name: string;
  streamUrl: string;
  websiteUrl: string;
  logoUrl: string;
  genre: string;
  isLive: boolean;
  nowPlaying: string;
  listeners?: number;
  error?: string;
}

// Check if an Icecast/Shoutcast stream is live
async function checkIcecastStream(url: string): Promise<{ isLive: boolean; nowPlaying: string; listeners: number | undefined }> {
  try {
    // Try to fetch stream metadata
    const response = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: {
        'Icy-MetaData': '1'
      }
    }, 5000);
    
    // If we get a response, stream is likely available
    if (response.ok || response.status === 200) {
      // Check for Icecast headers
      const icyName = response.headers.get('icy-name') || '';
      const icyDescription = response.headers.get('icy-description') || '';
      
      return {
        isLive: true,
        nowPlaying: icyName || icyDescription || 'Live stream',
        listeners: undefined
      };
    }
    
    return { isLive: false, nowPlaying: '', listeners: undefined };
  } catch (error: unknown) {
    // AbortError means timeout - stream might still be there but slow
    if (error instanceof Error && error.name === 'AbortError') {
      return { isLive: false, nowPlaying: '', listeners: undefined };
    }

    // Connection refused or network error
    return { isLive: false, nowPlaying: '', listeners: undefined };
  }
}

// Check Icecast status page (JSON)
async function checkIcecastStatus(statusUrl: string): Promise<{ isLive: boolean; nowPlaying: string; listeners: number | undefined }> {
  try {
    const response = await fetchWithTimeout(statusUrl, {}, 5000);
    
    if (!response.ok) {
      return { isLive: false, nowPlaying: '', listeners: undefined };
    }
    
    const text = await response.text();
    
    // Try parsing as JSON (Icecast 2.4+ status-json.xsl)
    try {
      const data = JSON.parse(text);
      
      if (data.icestats?.source) {
        const source = Array.isArray(data.icestats.source) 
          ? data.icestats.source[0] 
          : data.icestats.source;
        
        return {
          isLive: true,
          nowPlaying: source.title || source.server_name || 'Live',
          listeners: source.listeners || 0
        };
      }
    } catch (e: unknown) {
      // Not JSON, try parsing as XML or HTML
      if (text.includes('Mount Point') || text.includes('listeners')) {
        return { isLive: true, nowPlaying: 'Live stream', listeners: undefined };
      }
    }

    return { isLive: false, nowPlaying: '', listeners: undefined };
  } catch (e: unknown) {
    return { isLive: false, nowPlaying: '', listeners: undefined };
  }
}

// Simple HTTP check (just see if URL responds)
async function checkHttpStatus(url: string): Promise<{ isLive: boolean; nowPlaying: string; listeners: number | undefined }> {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'HEAD'
    }, 5000);

    return {
      isLive: response.ok,
      nowPlaying: response.ok ? 'Stream available' : '',
      listeners: undefined
    };
  } catch (e: unknown) {
    return { isLive: false, nowPlaying: '', listeners: undefined };
  }
}

// GET - Check all relay sources or specific one
export const GET: APIRoute = async ({ request, locals }) => {
  // SECURITY: Rate limit to prevent abuse
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`check-relays:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // SECURITY: Require admin auth - relay URLs are fetched server-side
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;  try {
    const url = new URL(request.url);
    const sourceId = url.searchParams.get('id');
    const activeOnly = url.searchParams.get('activeOnly') !== 'false';
    
    const filters = [];
    if (activeOnly) {
      filters.push({ field: 'active', op: 'EQUAL' as const, value: true });
    }

    const allSources = await queryCollection('relaySources', {
      filters: filters.length > 0 ? filters : undefined
    });

    const sources = sourceId
      ? allSources.filter((doc: Record<string, unknown>) => doc.id === sourceId)
      : allSources;
    
    // Check each source
    const results: RelayStatus[] = await Promise.all(
      sources.map(async (source: Record<string, unknown>) => {
        let status = { isLive: false, nowPlaying: '', listeners: undefined as number | undefined };
        
        try {
          switch (source.checkMethod) {
            case 'icecast':
              if (source.statusUrl) {
                status = await checkIcecastStatus(source.statusUrl);
              } else {
                status = await checkIcecastStream(source.streamUrl);
              }
              break;
            
            case 'http':
              status = await checkHttpStatus(source.statusUrl || source.streamUrl);
              break;
            
            case 'stream':
              status = await checkIcecastStream(source.streamUrl);
              break;
            
            default:
              // No check method - assume available if we have a URL
              status = { isLive: !!source.streamUrl, nowPlaying: '', listeners: undefined };
          }
          
          // Update the source in Firestore with latest status
          await updateDocument('relaySources', source.id, {
            isCurrentlyLive: status.isLive,
            nowPlaying: status.nowPlaying,
            lastChecked: new Date().toISOString()
          });
          
        } catch (error: unknown) {
          log.error(`Error checking ${source.name}:`, error instanceof Error ? error.message : String(error));
        }
        
        return {
          id: source.id,
          name: source.name,
          streamUrl: source.streamUrl,
          websiteUrl: source.websiteUrl,
          logoUrl: source.logoUrl,
          genre: source.genre,
          isLive: status.isLive,
          nowPlaying: status.nowPlaying,
          listeners: status.listeners
        };
      })
    );
    
    // Sort: live streams first
    results.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return a.name.localeCompare(b.name);
    });
    
    return successResponse({ relays: results,
      liveCount: results.filter(r => r.isLive).length,
      checkedAt: new Date().toISOString() });
  } catch (error: unknown) {
    log.error('Error checking relay sources:', error);
    return ApiErrors.serverError('Internal error');
  }
};
