// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';

const isProduction = process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  integrations: [
    sitemap({
      filter: (page) =>
        !page.includes('/admin') &&
        !page.includes('/account/') &&
        !page.includes('/api/') &&
        !page.includes('/cart') &&
        !page.includes('/checkout') &&
        !page.includes('/verify-email') &&
        !page.includes('/forgot-password') &&
        !page.includes('/supplier/') &&
        !page.includes('/live/embed') &&
        !page.includes('/live/fullpage'),
      changefreq: 'weekly',
      priority: 0.7,
      lastmod: new Date(),
    }),
  ],

  // Astro 5: use 'static' or 'server'
  // For hybrid behavior, use 'server' + prerender on individual pages
  output: 'server',

  // Enable CSRF protection (validates request origin)
  security: {
    checkOrigin: true
  },
  
  adapter: isProduction 
    ? cloudflare({ 
        mode: 'directory',
        runtime: {
          mode: 'local',
          type: 'pages'
        }
      }) 
    : node({ mode: 'standalone' }),
    
  site: 'https://freshwax.co.uk',
  
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      external: ['firebase-admin']
    },
    optimizeDeps: {
      include: ['firebase/app', 'firebase/firestore']
    }
  }
});