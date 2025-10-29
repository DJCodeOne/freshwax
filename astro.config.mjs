import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';

// Check if we're building for production
const isProduction = process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  integrations: [tailwind(), react()],
  // Use server mode to enable API routes
  output: 'server',
  // Use node adapter for dev, cloudflare for production
  adapter: isProduction ? cloudflare({ mode: 'directory' }) : node({ mode: 'standalone' }),
  site: 'https://freshwax.co.uk',
});
