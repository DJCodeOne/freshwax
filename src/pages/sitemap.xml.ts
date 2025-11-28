---
// src/pages/sitemap.xml.ts
// Dynamic XML sitemap for SEO
import type { APIRoute } from 'astro';
import { queryCollection, getLiveReleases } from '../lib/firebase-rest';

export const prerender = false;

const SITE_URL = 'https://freshwax.co.uk';

// Static pages with their priority and change frequency
const staticPages = [
  { url: '/', priority: '1.0', changefreq: 'daily' },
  { url: '/releases', priority: '0.9', changefreq: 'daily' },
  { url: '/dj-mixes', priority: '0.8', changefreq: 'weekly' },
  { url: '/merch', priority: '0.8', changefreq: 'weekly' },
  { url: '/about', priority: '0.6', changefreq: 'monthly' },
  { url: '/contact', priority: '0.6', changefreq: 'monthly' },
  { url: '/shipping', priority: '0.5', changefreq: 'monthly' },
  { url: '/returns', priority: '0.5', changefreq: 'monthly' },
  { url: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { url: '/terms', priority: '0.3', changefreq: 'yearly' },
  { url: '/cookies', priority: '0.3', changefreq: 'yearly' },
];

export const GET: APIRoute = async () => {
  const today = new Date().toISOString().split('T')[0];
  
  // Fetch dynamic content
  let releases: any[] = [];
  let djMixes: any[] = [];
  let merchItems: any[] = [];
  
  try {
    releases = await getLiveReleases(100);
  } catch (e) {
    console.error('[Sitemap] Error fetching releases:', e);
  }
  
  try {
    djMixes = await queryCollection('djMixes', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'published' }],
      limit: 100,
      cacheKey: 'sitemap-dj-mixes',
      cacheTTL: 60 * 60 * 1000 // 1 hour cache
    });
  } catch (e) {
    console.error('[Sitemap] Error fetching DJ mixes:', e);
  }
  
  try {
    merchItems = await queryCollection('merch', {
      filters: [
        { field: 'published', op: 'EQUAL', value: true },
        { field: 'status', op: 'EQUAL', value: 'active' }
      ],
      limit: 100,
      cacheKey: 'sitemap-merch',
      cacheTTL: 60 * 60 * 1000
    });
  } catch (e) {
    console.error('[Sitemap] Error fetching merch:', e);
  }
  
  // Build XML
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
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
  
  // Release pages
  for (const release of releases) {
    const lastmod = release.updatedAt || release.releaseDate || today;
    const imageUrl = release.coverArtUrl || release.artworkUrl;
    
    xml += `  <url>
    <loc>${SITE_URL}/item/${release.id}</loc>
    <lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>`;
    
    if (imageUrl) {
      xml += `
    <image:image>
      <image:loc>${imageUrl}</image:loc>
      <image:title>${escapeXml(release.releaseName || release.title || 'Release')}</image:title>
    </image:image>`;
    }
    
    xml += `
  </url>
`;
  }
  
  // DJ Mix pages
  for (const mix of djMixes) {
    const lastmod = mix.updatedAt || mix.createdAt || today;
    const imageUrl = mix.artworkUrl || mix.coverUrl;
    
    xml += `  <url>
    <loc>${SITE_URL}/dj-mix/${mix.id}</loc>
    <lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>`;
    
    if (imageUrl) {
      xml += `
    <image:image>
      <image:loc>${imageUrl}</image:loc>
      <image:title>${escapeXml(mix.title || 'DJ Mix')}</image:title>
    </image:image>`;
    }
    
    xml += `
  </url>
`;
  }
  
  // Merch pages
  for (const item of merchItems) {
    const lastmod = item.updatedAt || item.createdAt || today;
    const imageUrl = item.primaryImage || item.images?.[0]?.url;
    
    xml += `  <url>
    <loc>${SITE_URL}/merch/${item.id}</loc>
    <lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>`;
    
    if (imageUrl) {
      xml += `
    <image:image>
      <image:loc>${imageUrl}</image:loc>
      <image:title>${escapeXml(item.name || 'Merchandise')}</image:title>
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
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600' // 1 hour cache
    }
  });
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}