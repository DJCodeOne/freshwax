import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';

const isProduction = process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  integrations: [tailwind()],
  output: 'server',
  adapter: isProduction ? cloudflare({ mode: 'directory' }) : node({ mode: 'standalone' }),
  site: 'https://freshwax.co.uk',
});