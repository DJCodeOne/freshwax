// src/pages/api/livestream/check-relays.ts
// API to check if external radio streams are live
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

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
async function checkIcecastStream(url: string): Promise<{ isLive: boolean; nowPlaying: string; listeners?: number }> {
  try {
    // Try to fetch stream metadata
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'Icy-MetaData': '1'
      }
    });
    
    clearTimeout(timeout);
    
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
    
    return { isLive: false, nowPlaying: '' };
  } catch (error: any) {
    // AbortError means timeout - stream might still be there but slow
    if (error.name === 'AbortError') {
      return { isLive: false, nowPlaying: '', listeners: undefined };
    }
    
    // Connection refused or network error
    return { isLive: false, nowPlaying: '' };
  }
}

// Check Icecast status page (JSON)
async function checkIcecastStatus(statusUrl: string): Promise<{ isLive: boolean; nowPlaying: string; listeners?: number }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(statusUrl, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      return { isLive: false, nowPlaying: '' };
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
    } catch {
      // Not JSON, try parsing as XML or HTML
      if (text.includes('Mount Point') || text.includes('listeners')) {
        return { isLive: true, nowPlaying: 'Live stream' };
      }
    }
    
    return { isLive: false, nowPlaying: '' };
  } catch {
    return { isLive: false, nowPlaying: '' };
  }
}

// Simple HTTP check (just see if URL responds)
async function checkHttpStatus(url: string): Promise<{ isLive: boolean; nowPlaying: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    return {
      isLive: response.ok,
      nowPlaying: response.ok ? 'Stream available' : ''
    };
  } catch {
    return { isLive: false, nowPlaying: '' };
  }
}

// GET - Check all relay sources or specific one
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
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
      ? allSources.filter((doc: any) => doc.id === sourceId)
      : allSources;
    
    // Check each source
    const results: RelayStatus[] = await Promise.all(
      sources.map(async (source: any) => {
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
              status = { isLive: !!source.streamUrl, nowPlaying: '' };
          }
          
          // Update the source in Firestore with latest status
          await updateDocument('relaySources', source.id, {
            isCurrentlyLive: status.isLive,
            nowPlaying: status.nowPlaying,
            lastChecked: new Date().toISOString()
          });
          
        } catch (error: any) {
          console.error(`Error checking ${source.name}:`, error.message);
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
    
    return new Response(JSON.stringify({ 
      success: true, 
      relays: results,
      liveCount: results.filter(r => r.isLive).length,
      checkedAt: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Error checking relay sources:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
