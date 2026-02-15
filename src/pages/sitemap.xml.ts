// src/pages/sitemap.xml.ts
// Dynamic XML sitemap with audio/video extensions for music e-commerce
// Queries Firebase at request time to include all dynamic product URLs
// Cached for 1 hour at edge, with stale-while-revalidate for performance

import { getLiveReleases, getLiveDJMixes, getLiveMerch, queryCollection } from '../lib/firebase-rest';
import { blogPosts } from '../data/blog-posts';

export const prerender = false;

const SITE_URL = 'https://freshwax.co.uk';

// Static pages with priority and change frequency based on importance
// Pages with lastmod: 'dynamic:<source>' will be resolved at request time from fetched data
const staticPages = [
  // High priority - main conversion/browse pages (lastmod derived from latest content)
  { url: '/', priority: '1.0', changefreq: 'daily', lastmod: 'dynamic:all' },
  { url: '/releases/', priority: '0.9', changefreq: 'daily', lastmod: 'dynamic:releases' },
  { url: '/dj-mixes/', priority: '0.9', changefreq: 'daily', lastmod: 'dynamic:djMixes' },
  { url: '/dj-mix-chart/', priority: '0.8', changefreq: 'daily', lastmod: 'dynamic:djMixes' },
  { url: '/weekly-chart/', priority: '0.8', changefreq: 'weekly', lastmod: 'dynamic:releases' },
  { url: '/merch/', priority: '0.8', changefreq: 'weekly', lastmod: 'dynamic:merch' },
  { url: '/crates/', priority: '0.8', changefreq: 'daily', lastmod: 'dynamic:vinyl' },
  { url: '/live/', priority: '0.8', changefreq: 'hourly', lastmod: 'dynamic:all' },
  { url: '/pre-orders/', priority: '0.8', changefreq: 'weekly', lastmod: 'dynamic:releases' },
  { url: '/samples/', priority: '0.7', changefreq: 'weekly', lastmod: 'dynamic:releases' },
  { url: '/blog/', priority: '0.7', changefreq: 'weekly', lastmod: 'dynamic:blog' },
  { url: '/schedule/', priority: '0.7', changefreq: 'daily', lastmod: 'dynamic:all' },

  // Medium priority - informational/conversion (fixed lastmod dates)
  { url: '/giftcards/', priority: '0.7', changefreq: 'monthly', lastmod: '2025-06-01' },
  { url: '/upload-mix/', priority: '0.6', changefreq: 'monthly', lastmod: '2025-06-01' },
  { url: '/newsletter/', priority: '0.6', changefreq: 'monthly', lastmod: '2025-06-01' },
  { url: '/about/', priority: '0.6', changefreq: 'monthly', lastmod: '2025-06-01' },
  { url: '/contact/', priority: '0.6', changefreq: 'monthly', lastmod: '2025-06-01' },

  // Lower priority - policy pages (fixed lastmod - updated during GDPR work Feb 2026)
  { url: '/shipping/', priority: '0.5', changefreq: 'monthly', lastmod: '2025-06-01' },
  { url: '/returns/', priority: '0.5', changefreq: 'monthly', lastmod: '2025-06-01' },
  { url: '/privacy/', priority: '0.3', changefreq: 'yearly', lastmod: '2026-02-15' },
  { url: '/terms/', priority: '0.3', changefreq: 'yearly', lastmod: '2026-02-15' },
  { url: '/cookies/', priority: '0.3', changefreq: 'yearly', lastmod: '2026-02-15' },
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

export const GET = async ({ locals }: { locals: App.Locals }) => {
  const today = new Date().toISOString().split('T')[0];

  // Get D1 binding for optimized reads
  const db = locals?.runtime?.env?.DB;

  let releases: any[] = [];
  let djMixes: any[] = [];
  let merchItems: any[] = [];
  let vinylListings: any[] = [];

  // Fetch all dynamic content in parallel for performance
  const [releasesResult, djMixesResult, merchResult, vinylResult] = await Promise.allSettled([
    getLiveReleases(500),
    getLiveDJMixes(500),
    getLiveMerch(500),
    queryCollection('vinylListings', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'published' }],
      limit: 500,
      cacheKey: 'sitemap:vinylListings',
      cacheTTL: 3600000  // 1 hour
    })
  ]);

  if (releasesResult.status === 'fulfilled') releases = releasesResult.value;
  if (djMixesResult.status === 'fulfilled') djMixes = djMixesResult.value;
  if (merchResult.status === 'fulfilled') merchItems = merchResult.value;
  if (vinylResult.status === 'fulfilled') vinylListings = vinylResult.value;

  // Compute the most recent update date per content source for listing page lastmod
  function getLatestDate(items: any[], fields: string[]): string {
    let latest = 0;
    for (const item of items) {
      for (const field of fields) {
        if (item[field]) {
          const ts = new Date(item[field]).getTime();
          if (!isNaN(ts) && ts > latest) latest = ts;
        }
      }
    }
    return latest > 0 ? new Date(latest).toISOString().split('T')[0] : today;
  }

  // Most recent blog post date
  const latestBlog = blogPosts.length > 0
    ? blogPosts.reduce((latest, p) => p.publishedAt > latest ? p.publishedAt : latest, blogPosts[0].publishedAt)
    : today;

  const dynamicLastmod: Record<string, string> = {
    releases: getLatestDate(releases, ['updatedAt', 'releaseDate', 'createdAt']),
    djMixes: getLatestDate(djMixes, ['updatedAt', 'createdAt']),
    merch: getLatestDate(merchItems, ['updatedAt', 'createdAt']),
    vinyl: getLatestDate(vinylListings, ['updatedAt', 'createdAt']),
    blog: latestBlog,
  };
  // 'all' = the most recent across every source
  dynamicLastmod.all = Object.values(dynamicLastmod).reduce((a, b) => a > b ? a : b);

  // Resolve a page's lastmod: dynamic sources are looked up, fixed dates pass through
  function resolveLastmod(raw: string): string {
    if (raw.startsWith('dynamic:')) {
      const key = raw.slice('dynamic:'.length);
      return dynamicLastmod[key] || today;
    }
    return raw; // already a YYYY-MM-DD string
  }

  // Build XML with all extensions
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
`;

  // ===========================================
  // STATIC PAGES
  // ===========================================
  for (const page of staticPages) {
    xml += `  <url>
    <loc>${SITE_URL}${page.url}</loc>
    <lastmod>${resolveLastmod(page.lastmod)}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>
`;
  }

  // ===========================================
  // BLOG POSTS (static data)
  // ===========================================
  for (const post of blogPosts) {
    const lastmod = formatDate(post.publishedAt);
    xml += `  <url>
    <loc>${SITE_URL}/blog/${post.slug}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>`;

    if (isValidImageUrl(post.featuredImage)) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(post.featuredImage)}</image:loc>
      <image:title>${escapeXml(post.title)}</image:title>
    </image:image>`;
    }

    xml += `
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
    <loc>${SITE_URL}/item/${release.id}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>`;

    // Image extension for rich image results (only valid absolute URLs)
    if (isValidImageUrl(imageUrl)) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}${artist ? ` by ${artist}` : ''}</image:title>
      <image:caption>${title} - ${escapeXml(Array.isArray(genres) ? genres.join(', ') : String(genres))} release on ${label}</image:caption>
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
    <loc>${SITE_URL}/dj-mix/${mix.id}/</loc>
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
      <video:uploader info="${SITE_URL}/about/">${dj || 'Fresh Wax'}</video:uploader>
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
    <loc>${SITE_URL}/merch/${item.id}/</loc>
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
  // CRATES - Vinyl marketplace listings
  // ===========================================
  for (const listing of vinylListings) {
    const lastmod = formatDate(listing.updatedAt || listing.createdAt);
    const imageUrl = listing.images?.[0]?.url || listing.imageUrl;
    const title = escapeXml(listing.title || listing.artist ? `${listing.artist} - ${listing.title}` : 'Vinyl Record');
    const condition = listing.mediaCondition || listing.condition || '';

    xml += `  <url>
    <loc>${SITE_URL}/crates/${listing.id}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>`;

    if (isValidImageUrl(imageUrl)) {
      xml += `
    <image:image>
      <image:loc>${escapeXml(imageUrl)}</image:loc>
      <image:title>${title}${condition ? ` (${escapeXml(condition)})` : ''}</image:title>
      <image:caption>Vinyl record for sale - ${title}</image:caption>
    </image:image>`;
    }

    xml += `
  </url>
`;
  }

  // ===========================================
  // ARTIST FILTER PAGES
  // ===========================================
  // Get unique artists from releases for filtered browse pages
  // Build a map of artist -> most recent release date for accurate lastmod
  const artistLatest = new Map<string, string>();
  for (const r of releases) {
    const name = r.artistName || r.artist;
    if (!name) continue;
    const date = formatDate(r.updatedAt || r.releaseDate || r.createdAt);
    const existing = artistLatest.get(name);
    if (!existing || date > existing) artistLatest.set(name, date);
  }
  const artists = [...artistLatest.keys()];
  for (const artist of artists.slice(0, 100)) { // Limit to 100 artists
    xml += `  <url>
    <loc>${SITE_URL}/releases/?artist=${encodeURIComponent(artist)}</loc>
    <lastmod>${artistLatest.get(artist)}</lastmod>
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
