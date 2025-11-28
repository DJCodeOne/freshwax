---
// src/pages/robots.txt.ts
import type { APIRoute } from 'astro';

export const prerender = true;

const SITE_URL = 'https://freshwax.co.uk';

export const GET: APIRoute = () => {
  const robotsTxt = `# Fresh Wax Robots.txt
# https://freshwax.co.uk

User-agent: *
Allow: /

# Disallow admin and private areas
Disallow: /admin/
Disallow: /artist/
Disallow: /account/
Disallow: /api/
Disallow: /customer/account/
Disallow: /cart
Disallow: /checkout

# Disallow utility pages
Disallow: /*?*sort=
Disallow: /*?*filter=
Disallow: /*?*page=

# Sitemap
Sitemap: ${SITE_URL}/sitemap.xml

# Crawl-delay (be nice to servers)
Crawl-delay: 1
`;

  return new Response(robotsTxt, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=86400' // 24 hour cache
    }
  });
};