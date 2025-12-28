// src/pages/sitemap.xml.ts
// Enhanced Dynamic XML sitemap with audio/video extensions for music e-commerce
// Optimized for Google Search Console and rich results

import { queryCollection, getLiveReleases } from '../lib/firebase-rest';

export const prerender = false;

const SITE_URL = 'https://freshwax.co.uk';

// Static pages with priority and change frequency based on importance
const staticPages = [
  // High priority - main conversion pages
  { url: '/', priority: '1.0', changefreq: 'daily' },
  { url: '/releases', priority: '0.9', changefreq: 'daily' },
  { url: '/dj-mixes', priority: '0.9', changefreq: 'daily' },
  { url: '/dj-mix-chart', priority: '0.8', changefreq: 'daily' },
  { url: '/merch', priority: '0.8', changefreq: 'weekly' },
  { url: '/live', priority: '0.8', changefreq: 'hourly' },
  
  // Medium priority - informational/conversion
  { url: '/giftcards', priority: '0.7', changefreq: 'monthly' },
  { url: '/gift-cards', priority: '0.7', changefreq: 'monthly' },
  { url: '/about', priority: '0.6', changefreq: 'monthly' },
  { url: '/contact', priority: '0.6', changefreq: 'monthly' },
  
  // Lower priority - policy pages (but important for trust)
  { url: '/shipping', priority: '0.5', changefreq: 'monthly' },
  { url: '/returns', priority: '0.5', changefreq: 'monthly' },
  { url: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { url: '/terms', priority: '0.3', changefreq: 'yearly' },
  { url: '/cookies', priority: '0.3', changefreq: 'yearly' },
  
  // Account pages (noindex but included for completeness)
  { url: '/login', priority: '0.4', changefreq: 'monthly' },
  { url: '/register', priority: '0.4', changefreq: 'monthly' },
];

function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Check if URL is valid for sitemap (absolute, not placeholder)
function isValidImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.includes('place-holder') || url.includes('placeholder')) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

function formatDate(date: any): string {
  if (!date) return new Date().toISOString().split('T')[0];
  try {
    const d = new Date(date);
    return isNaN(d.getTime()) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// Convert duration in seconds to ISO 8601 format
function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return 'PT0S';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  let duration = 'PT';
  if (hours > 0) duration += `${hours}H`;
  if (minutes > 0) duration += `${minutes}M`;
  if (secs > 0 || duration === 'PT') duration += `${secs}S`;
  return duration;
}

export const GET = async () => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  
  let releases: any[] = [];
  let djMixes: any[] = [];
  let merchItems: any[] = [];
  
  // Fetch all dynamic content in parallel for performance
  const [releasesResult, djMixesResult, merchResult] = await Promise.allSettled([
    getLiveReleases(500),
    queryCollection('dj-mixes', {
      filters: [{ field: 'published', op: 'EQUAL', value: true }],
      limit: 500,
      cacheKey: 'sitemap-dj-mixes',
      cacheTTL: 60 * 60 * 1000
    }),
    queryCollection('merch', {
      filters: [
        { field: 'published', op: 'EQUAL', value: true },
        { field: 'status', op: 'EQUAL', value: 'active' }
      ],
      limit: 500,
      cacheKey: 'sitemap-merch',
      cacheTTL: 60 * 60 * 1000
    })
  ]);
  
  if (releasesResult.status === 'fulfilled') releases = releasesResult.value;
  if (djMixesResult.status === 'fulfilled') djMixes = djMixesResult.value;
  if (merchResult.status === 'fulfilled') merchItems = merchResult.value;

  // Build XML with all extensions
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
`;

  // Static pages
  for (const page of staticPages) {
    xml += `  <url>
    <loc>${SITE_URL}${page.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>
`;
  }
  
  // ===========================================
  // RELEASES - Product pages (highest priority)
  // ===========================================
  for (const release of releases) {
    const lastmod = formatDate(release.updatedAt || release.releaseDate);
    const imageUrl = release.coverArtUrl || release.artworkUrl;
    const title = escapeXml(release.releaseName || release.title || 'Release');
    const artist = escapeXml(release.artistName || release.artist || '');
    const label = escapeXml(release.label || 'Fresh Wax');
    const genres = release.genres || release.genre || ['Jungle', 'Drum and Bass'];
    
    xml += `  <url>
    <loc>${SITE_URL}/item/${release.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>`;
    
    // Image extension for rich image results (only valid absolute URLs)
    if (isValidImageUrl(imageUrl)) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}${artist ? ` by ${artist}` : ''}</image:title>
      <image:caption>${title} - ${Array.isArray(genres) ? genres.join(', ') : genres} release on ${label}</image:caption>
      <image:geo_location>United Kingdom</image:geo_location>
      <image:license>https://freshwax.co.uk/terms</image:license>
    </image:image>`;
    }
    
    xml += `
  </url>
`;
  }
  
  // ===========================================
  // DJ MIXES - Audio content pages
  // ===========================================
  for (const mix of djMixes) {
    const lastmod = formatDate(mix.updatedAt || mix.createdAt);
    const imageUrl = mix.artworkUrl || mix.coverUrl || mix.thumbnailUrl;
    const title = escapeXml(mix.title || 'DJ Mix');
    const dj = escapeXml(mix.djName || mix.artist || '');
    const description = escapeXml(mix.description || `${title} by ${dj} - Jungle and Drum & Bass DJ mix on Fresh Wax`);
    const duration = mix.duration || mix.durationSeconds;
    const uploadDate = formatDate(mix.createdAt || mix.uploadDate);
    
    xml += `  <url>
    <loc>${SITE_URL}/dj-mix/${mix.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>`;
    
    // Image for the mix artwork (only valid absolute URLs)
    if (isValidImageUrl(imageUrl)) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}${dj ? ` by ${dj}` : ''}</image:title>
      <image:caption>DJ Mix artwork - ${title}</image:caption>
    </image:image>`;

      // Video extension can be used for audio content with thumbnail
      // Google treats audio content similarly for rich results
      if (duration) {
        xml += `
    <video:video>
      <video:thumbnail_loc>${escapeXml(imageUrl)}</video:thumbnail_loc>
      <video:title>${title}${dj ? ` by ${dj}` : ''}</video:title>
      <video:description>${description.substring(0, 2048)}</video:description>
      <video:duration>${typeof duration === 'number' ? duration : 3600}</video:duration>
      <video:publication_date>${uploadDate}T00:00:00+00:00</video:publication_date>
      <video:family_friendly>yes</video:family_friendly>
      <video:live>no</video:live>
      <video:category>Music</video:category>
      <video:tag>jungle</video:tag>
      <video:tag>drum and bass</video:tag>
      <video:tag>dj mix</video:tag>
      <video:tag>electronic music</video:tag>
      <video:uploader info="${SITE_URL}/about">${dj || 'Fresh Wax'}</video:uploader>
    </video:video>`;
      }
    }
    
    xml += `
  </url>
`;
  }
  
  // ===========================================
  // MERCH - Product pages
  // ===========================================
  for (const item of merchItems) {
    const lastmod = formatDate(item.updatedAt || item.createdAt);
    const primaryImage = item.primaryImage || item.images?.[0]?.url;
    const title = escapeXml(item.name || 'Merchandise');
    const description = escapeXml(item.description || `Fresh Wax official merchandise - ${title}`);
    
    xml += `  <url>
    <loc>${SITE_URL}/merch/${item.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>`;
    
    // Primary image (only valid absolute URLs)
    if (isValidImageUrl(primaryImage)) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(primaryImage)}</image:loc>
      <image:title>${title}</image:title>
      <image:caption>${description.substring(0, 200)}</image:caption>
    </image:image>`;
    }

    // Additional images (only valid absolute URLs)
    if (item.images && Array.isArray(item.images)) {
      for (const img of item.images.slice(1, 5)) { // Max 5 images per URL
        if (isValidImageUrl(img.url) && img.url !== primaryImage) {
          xml += `
    <image:image>
      <image:loc>${escapeXml(img.url)}</image:loc>
      <image:title>${title} - ${escapeXml(img.alt || 'Product image')}</image:title>
    </image:image>`;
        }
      }
    }
    
    xml += `
  </url>
`;
  }
  
  // ===========================================
  // ARTIST PAGES (if you have dedicated artist pages)
  // ===========================================
  // Get unique artists from releases
  const artists = [...new Set(releases.map(r => r.artistName || r.artist).filter(Boolean))];
  for (const artist of artists.slice(0, 100)) { // Limit to 100 artists
    const artistSlug = artist.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    xml += `  <url>
    <loc>${SITE_URL}/releases?artist=${encodeURIComponent(artist)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
`;
  }
  
  xml += `</urlset>`;
  
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      'X-Robots-Tag': 'noindex' // Sitemap itself shouldn't be indexed
    }
  });
};
