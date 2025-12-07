// src/pages/robots.txt.ts
// Enhanced robots.txt for Fresh Wax - optimized for search engine crawling

export const prerender = true;

const SITE_URL = 'https://freshwax.co.uk';

export const GET = () => {
  const robotsTxt = `# ===========================================
# Fresh Wax Robots.txt
# ${SITE_URL}
# Independent Jungle & Drum and Bass Music Store
# ===========================================

# Allow all legitimate search engine crawlers
User-agent: *
Allow: /

# ===========================================
# DISALLOW - Admin and Private Areas
# ===========================================
Disallow: /admin/
Disallow: /admin
Disallow: /artist/
Disallow: /account/
Disallow: /api/
Disallow: /checkout
Disallow: /checkout/
Disallow: /cart
Disallow: /order-confirmation/

# ===========================================
# DISALLOW - Utility/Filter URLs (prevent duplicate content)
# ===========================================
Disallow: /*?sort=*
Disallow: /*?filter=*
Disallow: /*?page=*
Disallow: /*?search=*
Disallow: /*?ref=*
Disallow: /*?utm_*
Disallow: /*?fbclid=*
Disallow: /*?gclid=*
Disallow: /*?msclkid=*

# ===========================================
# DISALLOW - Internal/Technical Pages
# ===========================================
Disallow: /_astro/
Disallow: /_worker/
Disallow: /cdn-cgi/
Disallow: /*.json$
Disallow: /temp/
Disallow: /test-*

# ===========================================
# SPECIFIC BOT RULES
# ===========================================

# Google - Allow everything we want indexed
User-agent: Googlebot
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /account/
Disallow: /checkout
Disallow: /cart

# Google Images - Encourage image indexing
User-agent: Googlebot-Image
Allow: /
Allow: /*.webp$
Allow: /*.jpg$
Allow: /*.png$
Disallow: /admin/

# Google Video - for DJ mix thumbnails
User-agent: Googlebot-Video
Allow: /dj-mix/
Allow: /live
Disallow: /admin/

# Bing
User-agent: Bingbot
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /account/
Disallow: /checkout
Crawl-delay: 1

# Yandex
User-agent: Yandex
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /account/
Crawl-delay: 2

# DuckDuckGo
User-agent: DuckDuckBot
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /account/

# Facebook crawler (for Open Graph)
User-agent: facebookexternalhit
Allow: /

# Twitter crawler (for Twitter Cards)
User-agent: Twitterbot
Allow: /

# LinkedIn crawler
User-agent: LinkedInBot
Allow: /

# Pinterest crawler
User-agent: Pinterest
Allow: /

# ===========================================
# BLOCK - Aggressive/Bad Bots
# ===========================================
User-agent: AhrefsBot
Disallow: /

User-agent: SemrushBot
Disallow: /

User-agent: MJ12bot
Disallow: /

User-agent: DotBot
Disallow: /

User-agent: BLEXBot
Disallow: /

User-agent: SearchAtlas
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: PetalBot
Disallow: /

# AI Training Bots (optional - remove if you want to be included in AI training)
User-agent: GPTBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Claude-Web
Disallow: /

# ===========================================
# SITEMAP
# ===========================================
Sitemap: ${SITE_URL}/sitemap.xml

# ===========================================
# CRAWL SETTINGS
# ===========================================
# Request 1 second delay between requests for politeness
Crawl-delay: 1

# ===========================================
# HOST (for search engines that support it)
# ===========================================
Host: ${SITE_URL}
`;

  return new Response(robotsTxt, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400', // 24 hour cache
      'X-Robots-Tag': 'noindex' // robots.txt itself shouldn't be indexed
    }
  });
};
