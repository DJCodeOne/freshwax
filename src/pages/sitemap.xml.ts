// src/pages/sitemap.xml.ts
// Dynamic XML sitemap with audio/video extensions for music e-commerce
// Queries Firebase at request time to include all dynamic product URLs
// Cached for 1 hour at edge, with stale-while-revalidate for performance

import { getLiveReleases, getLiveDJMixes, getLiveMerch, queryCollection } from '../lib/firebase-rest';
import { blogPosts } from '../data/blog-posts';

export const prerender = false;

const SITE_URL = 'https://freshwax.co.uk';

// Static pages with priority and change frequency based on importance
const staticPages = [
  // High priority - main conversion/browse pages
  { url: '/', priority: '1.0', changefreq: 'daily' },
  { url: '/releases/', priority: '0.9', changefreq: 'daily' },
  { url: '/dj-mixes/', priority: '0.9', changefreq: 'daily' },
  { url: '/dj-mix-chart/', priority: '0.8', changefreq: 'daily' },
  { url: '/weekly-chart/', priority: '0.8', changefreq: 'weekly' },
  { url: '/merch/', priority: '0.8', changefreq: 'weekly' },
  { url: '/crates/', priority: '0.8', changefreq: 'daily' },
  { url: '/live/', priority: '0.8', changefreq: 'hourly' },
  { url: '/pre-orders/', priority: '0.8', changefreq: 'weekly' },
  { url: '/samples/', priority: '0.7', changefreq: 'weekly' },
  { url: '/blog/', priority: '0.7', changefreq: 'weekly' },
  { url: '/schedule/', priority: '0.7', changefreq: 'daily' },

  // Medium priority - informational/conversion
  { url: '/giftcards/', priority: '0.7', changefreq: 'monthly' },
  { url: '/upload-mix/', priority: '0.6', changefreq: 'monthly' },
  { url: '/newsletter/', priority: '0.6', changefreq: 'monthly' },
  { url: '/about/', priority: '0.6', changefreq: 'monthly' },
  { url: '/contact/', priority: '0.6', changefreq: 'monthly' },

  // Lower priority - policy pages (but important for trust)
  { url: '/shipping/', priority: '0.5', changefreq: 'monthly' },
  { url: '/returns/', priority: '0.5', changefreq: 'monthly' },
  { url: '/privacy/', priority: '0.3', changefreq: 'yearly' },
  { url: '/terms/', priority: '0.3', changefreq: 'yearly' },
  { url: '/cookies/', priority: '0.3', changefreq: 'yearly' },
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

export const GET = async ({ locals }: { locals: any }) => {
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
    <lastmod>${today}</lastmod>
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
  const artists = [...new Set(releases.map(r => r.artistName || r.artist).filter(Boolean))];
  for (const artist of artists.slice(0, 100)) { // Limit to 100 artists
    xml += `  <url>
    <loc>${SITE_URL}/releases/?artist=${encodeURIComponent(artist)}</loc>
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
