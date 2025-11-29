// src/pages/sitemap.xml.ts
// Dynamic XML sitemap optimised for music e-commerce
import { queryCollection, getLiveReleases } from '../lib/firebase-rest';

export const prerender = false;

const SITE_URL = 'https://freshwax.co.uk';

// Static pages - priority based on importance for conversions
const staticPages = [
  { url: '/', priority: '1.0', changefreq: 'daily' },
  { url: '/releases', priority: '0.9', changefreq: 'daily' },
  { url: '/dj-mixes', priority: '0.8', changefreq: 'weekly' },
  { url: '/merch', priority: '0.8', changefreq: 'weekly' },
  { url: '/about', priority: '0.5', changefreq: 'monthly' },
  { url: '/contact', priority: '0.5', changefreq: 'monthly' },
  { url: '/shipping', priority: '0.4', changefreq: 'monthly' },
  { url: '/returns', priority: '0.4', changefreq: 'monthly' },
  { url: '/privacy', priority: '0.2', changefreq: 'yearly' },
  { url: '/terms', priority: '0.2', changefreq: 'yearly' },
  { url: '/cookies', priority: '0.2', changefreq: 'yearly' },
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

function formatDate(date: any): string {
  if (!date) return new Date().toISOString().split('T')[0];
  try {
    const d = new Date(date);
    return isNaN(d.getTime()) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

export const GET = async () => {
  const today = new Date().toISOString().split('T')[0];
  
  let releases: any[] = [];
  let djMixes: any[] = [];
  let merchItems: any[] = [];
  
  // Fetch all dynamic content
  try {
    releases = await getLiveReleases(200);
  } catch (e) {
    console.error('[Sitemap] Releases error:', e);
  }
  
  try {
    djMixes = await queryCollection('djMixes', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'published' }],
      limit: 200,
      cacheKey: 'sitemap-dj-mixes',
      cacheTTL: 60 * 60 * 1000
    });
  } catch (e) {
    console.error('[Sitemap] DJ mixes error:', e);
  }
  
  try {
    merchItems = await queryCollection('merch', {
      filters: [
        { field: 'published', op: 'EQUAL', value: true },
        { field: 'status', op: 'EQUAL', value: 'active' }
      ],
      limit: 200,
      cacheKey: 'sitemap-merch',
      cacheTTL: 60 * 60 * 1000
    });
  } catch (e) {
    console.error('[Sitemap] Merch error:', e);
  }

  // Build XML
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
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
  
  // Releases - highest priority product pages
  for (const release of releases) {
    const lastmod = formatDate(release.updatedAt || release.releaseDate);
    const imageUrl = release.coverArtUrl || release.artworkUrl;
    const title = escapeXml(release.releaseName || release.title || 'Release');
    const artist = escapeXml(release.artistName || release.artist || '');
    
    xml += `  <url>
    <loc>${SITE_URL}/item/${release.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>`;
    
    if (imageUrl) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}${artist ? ` by ${artist}` : ''}</image:title>
      <image:caption>${title} - Jungle and Drum &amp; Bass release on Fresh Wax</image:caption>
    </image:image>`;
    }
    
    xml += `
  </url>
`;
  }
  
  // DJ Mixes
  for (const mix of djMixes) {
    const lastmod = formatDate(mix.updatedAt || mix.createdAt);
    const imageUrl = mix.artworkUrl || mix.coverUrl;
    const title = escapeXml(mix.title || 'DJ Mix');
    const dj = escapeXml(mix.djName || mix.artist || '');
    
    xml += `  <url>
    <loc>${SITE_URL}/dj-mix/${mix.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>`;
    
    if (imageUrl) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}${dj ? ` by ${dj}` : ''}</image:title>
    </image:image>`;
    }
    
    xml += `
  </url>
`;
  }
  
  // Merch
  for (const item of merchItems) {
    const lastmod = formatDate(item.updatedAt || item.createdAt);
    const imageUrl = item.primaryImage || item.images?.[0]?.url;
    const title = escapeXml(item.name || 'Merchandise');
    
    xml += `  <url>
    <loc>${SITE_URL}/merch/${item.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>`;
    
    if (imageUrl) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}</image:title>
      <image:caption>Fresh Wax official merchandise - ${title}</image:caption>
    </image:image>`;
    }
    
    xml += `
  </url>
`;
  }
  
  xml += `</urlset>`;
  
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'X-Robots-Tag': 'noindex'
    }
  });
};