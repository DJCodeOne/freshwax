# FreshWax

E-commerce platform for Jungle and Drum & Bass music — vinyl, digital releases, DJ mixes, merch, and livestreaming.

## Tech Stack

- **Framework**: Astro 5 (SSR)
- **Hosting**: Cloudflare Workers / Pages
- **Database**: Firebase Firestore (REST API), Cloudflare D1
- **Storage**: Cloudflare R2 (native binding)
- **Cache**: Cloudflare KV
- **Payments**: Stripe, PayPal
- **Email**: Resend
- **Real-time**: Pusher, HLS livestreaming

## Prerequisites

- Node.js 22+
- Wrangler CLI (`npm i -g wrangler`)
- Cloudflare account with D1, R2, and KV configured
- Firebase project with service account credentials
- Stripe and PayPal accounts

Copy `.env.example` to `.env` and fill in all required values (59 vars).

## Quick Start

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Build targets Cloudflare Workers via the Astro Cloudflare adapter (~16-17s).

## Test

```bash
npm test                # Vitest unit tests
npx playwright test     # E2E tests
```

Coverage thresholds are enforced in `vitest.config.ts`.

## Deploy

Deployments run through GitHub Actions (`.github/workflows/`):

1. Install, audit, lint, typecheck, test, build
2. Deploy to Cloudflare Pages (main branch only)
3. Health check with automatic rollback on failure

Lighthouse CI runs against staging and production with enforced performance budgets.

## Key Directories

```
src/pages/         Astro pages and API endpoints (~150+)
src/lib/           Shared libraries (Firebase REST, auth, utilities, types)
src/components/    Astro components
src/styles/        Global CSS
public/            Static assets and client-side JS modules
database/          D1 schema and migrations
scripts/           Admin utility scripts
e2e/               Playwright E2E tests
workers/           Standalone Cloudflare Workers
```

## Notable Decisions

- **No Firebase SDK** — all Firestore via REST with service account JWT auth
- **No client-side framework** — pure Astro with vanilla JS
- **R2 native binding** — `@aws-sdk` kept only for presigned upload URLs
- **Do not** change `compatibility_date` beyond `2025-02-13` in `wrangler.toml`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for coding conventions and development guidelines.
