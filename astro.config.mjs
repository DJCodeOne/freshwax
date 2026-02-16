// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

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

  adapter: cloudflare({
    imageService: 'compile',
  }),

  site: 'https://freshwax.co.uk',

  trailingSlash: 'always',

  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // firebase-admin is dynamically imported by complete-upload.ts at runtime;
      // externalize so Vite doesn't try to bundle it (not installed as a dependency).
      // Node built-ins (fs, path, zlib, crypto) are provided by Cloudflare's
      // nodejs_compat flag at runtime — externalize to silence Vite warnings.
      external: [
        /^firebase-admin/,
        'node:fs', 'node:path', 'node:zlib', 'node:crypto',
        'fs', 'path', 'zlib', 'crypto',
      ]
    },
    build: {
      rollupOptions: {
        external: [/^firebase-admin/]
      }
    }
  }
});