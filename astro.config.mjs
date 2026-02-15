// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
const isProduction = process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  // Sitemap is handled by the custom dynamic endpoint at src/pages/sitemap.xml.ts
  // which queries Firebase at request time to include all product/mix/merch/crate URLs
  integrations: [],

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

  trailingSlash: 'always',
  
  vite: {
    plugins: [tailwindcss()],
    ssr: {},
    optimizeDeps: {
      include: ['firebase/app']
    }
  }
});