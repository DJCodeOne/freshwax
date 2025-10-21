import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

// Check if we're building for production
const isProduction = process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  integrations: [tailwind(), react()],
  output: isProduction ? 'server' : 'static',
  adapter: isProduction ? cloudflare({ mode: 'directory' }) : undefined,
  site: 'https://freshwax.co.uk',
});