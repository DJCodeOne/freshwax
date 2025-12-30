// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';

const isProduction = process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  integrations: [tailwind()],

  // Astro 5: use 'static' or 'server'
  // For hybrid behavior, use 'server' + prerender on individual pages
  output: 'server',

  // Disable CSRF check for API routes (needed for Pusher auth)
  security: {
    checkOrigin: false
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
    ssr: {
      external: ['firebase-admin']
    },
    optimizeDeps: {
      include: ['firebase/app', 'firebase/firestore']
    }
  }
});