# Freshwax

Jungle & Drum and Bass music e-commerce platform. Vinyl records, DJ mixes, merch, and live streaming.

## Tech Stack

- **Frontend**: Astro 5.x SSR (no client-side framework)
- **Runtime**: Cloudflare Workers / Pages
- **Database**: Firebase Firestore (REST API with service account JWT auth), Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (images, audio, DJ mixes)
- **Cache**: Cloudflare KV
- **Payments**: Stripe, PayPal
- **Email**: Resend
- **Real-time**: Pusher (chat, notifications)
- **Streaming**: Red5 Pro (live DJ streams)
- **Analytics**: GA4

## Project Structure

```
src/
  pages/                # Astro pages and API routes
    api/                # REST API endpoints (~150+)
      admin/            # Admin API routes
      artist/           # Artist/seller API routes
      auth/             # Authentication endpoints
      chat/             # Real-time chat API
      cron/             # Scheduled job endpoints
    admin/              # Admin dashboard pages
    artist/             # Artist/DJ dashboard pages
    pro/                # Pro subscription pages
    supplier/           # Supplier pages
  components/           # Shared Astro components
  layouts/              # Page layouts (Layout, InfoPageLayout)
  lib/                  # Shared utilities
    firebase-rest.ts    # Firebase REST API client (queryCollection, atomicIncrement, etc.)
    api-utils.ts        # API helpers (successResponse, ApiErrors, createLogger)
    rate-limit.ts       # In-memory rate limiting
    kv-cache.ts         # KV caching layer with invalidation
    escape-html.ts      # XSS prevention
    paypal-auth.ts      # PayPal OAuth2 token management
    pusher.ts           # Pusher server-side events
    constants.ts        # SITE_URL and shared constants
    types.ts            # Shared TypeScript types
    validation.ts       # Input validation
  stores/               # Client-side state
  styles/               # Global CSS (including admin-global.css)
  firebase/             # Firebase config
  __tests__/            # Vitest unit tests
  middleware.ts         # Cloudflare middleware (CSP, auth, redirects)
public/                 # Static assets
workers/                # Standalone Cloudflare Workers
  freshwax-api/         # Main API worker
  mix-processor/        # DJ mix processing
  release-processor/    # Release processing
  merch-processor/      # Merch image processing
  vinyl-api/            # Vinyl-specific API
e2e/                    # Playwright E2E tests
database/               # D1 schema and migrations
  schema.sql
  migrations/           # Numbered D1 migrations
```

## Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and fill in values
4. `npm run dev` -- start dev server
5. `npm run build` -- production build (~16-17s, watch for zero errors)
6. `npm run test` -- run Vitest unit tests

## Environment Variables

See `.env.example` for all required variables (59 vars).

Key categories: Firebase service account, Stripe keys, PayPal credentials, R2 bucket config, Resend API key, Pusher app credentials, Red5 streaming config, cron secrets.

## Deployment

Deployed to Cloudflare Pages via `wrangler pages deploy`.

- Environment variables managed in Cloudflare dashboard
- D1 bindings, R2 buckets, and KV namespaces configured in `wrangler.toml`
- **Do not** change `compatibility_date` beyond `2025-02-13` (breaks `Response.body` in middleware)
- Uses `nodejs_compat_v2` compatibility flag

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/deploy.yml`) runs on every push/PR to `main`:

1. **Validate** -- Install, security audit (`npm audit --audit-level=high` blocks on HIGH/CRITICAL), lint, typecheck, test, build
2. **Deploy** (main only) -- Downloads build artifact, captures previous deployment ID, deploys to Cloudflare Pages
3. **Health check** -- Hits `/api/health/public/` with 3 retries (30s initial wait, 10s between retries)
4. **Auto-rollback** -- If the health check fails and a previous deployment ID exists, rolls back via the Cloudflare API

### Manual Rollback

If automatic rollback fails or you need to rollback outside CI:

```bash
# List recent deployments (find the ID to rollback to)
npx wrangler pages deployment list --project-name=freshwax

# Rollback to a specific deployment by ID
curl -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/freshwax/deployments/$DEPLOYMENT_ID/rollback" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json"

# Verify the rollback
curl -s https://freshwax.co.uk/api/health/public/
```

Alternatively, rollback from the Cloudflare dashboard: **Workers & Pages > freshwax > Deployments > (select deployment) > Rollback**.

## Cron Jobs

Configured in Cloudflare Dashboard (Pages cron triggers, not wrangler.toml):

| Schedule       | Endpoint                             | Purpose                              |
|:---------------|:-------------------------------------|:-------------------------------------|
| `0 * * * *`    | `/api/cron/cleanup-reservations`     | Expire stale stock reservations      |
| `0 */6 * * *`  | `/api/cron/retry-payouts`            | Retry failed Stripe/PayPal payouts   |
| `0 */6 * * *`  | `/api/cron/send-restock-notifications` | Email users when items restock     |
| `0 2 * * *`    | `/api/cron/backup-d1`               | Back up D1 tables to R2 as JSON      |
| `0 3 * * *`    | `/api/cron/cleanup-d1`              | Purge old error logs, pending orders |
| `0 4 * * *`    | `/api/cron/image-scan`              | Scan R2 for non-WebP images          |
| `0 10 * * *`   | `/api/cron/verification-reminders`  | Remind unverified users              |
| `0 10 * * SUN` | `/api/cron/weekly-digest`           | Weekly digest email to followers     |

All cron endpoints require `Authorization: Bearer $CRON_SECRET`.

## Key Features

- **Vinyl marketplace** -- Buy and sell records with stock reservation system
- **DJ mix hosting** -- Upload, stream, and discover mixes with 400x400 WebP thumbnails
- **Merch store** -- Size/colour variants, inventory tracking
- **Live streaming** -- Red5 Pro relay with real-time Pusher chat
- **Artist dashboards** -- Sales analytics, payout tracking, release management
- **Admin panel** -- Order management, approvals, analytics, image tools, newsletter
- **Gift cards** -- Purchase and redemption flow
- **Crates** -- User record collections (wishlists)
- **Blog** -- Admin-managed content
- **GDPR compliance** -- Cookie consent, data export/deletion, age gate

## Testing

- **Unit tests**: `npm run test` (Vitest, in `src/__tests__/`)
- **E2E tests**: `npx playwright test` (Playwright, in `e2e/`)
- **Lighthouse CI**: GitHub Actions workflow with performance budgets

## Backup Strategy

- **Firestore**: Uses Firebase's built-in Point-in-Time Recovery (PITR), enabled via Google Cloud Console. No custom backup cron needed.
- **D1**: Backed up nightly to R2 as JSON by the `backup-d1` cron job (see Cron Jobs table above).

## Branch Protection

It is recommended to enable GitHub branch protection rules on the `main` branch: require at least one PR review and passing status checks (build + tests) before merging. This can be configured in the repository settings under Branches > Branch protection rules.

## Notable Architecture Decisions

- **Firebase REST API** -- No Firebase client SDK; all Firestore access goes through `firebase-rest.ts` using service account JWT + OAuth2 (RS256 via Web Crypto API)
- **No client-side framework** -- Pure Astro with vanilla JS in `<script>` tags; no React/Vue/Svelte
- **R2 native binding** -- Images and audio served via R2 binding in `wrangler.toml`; `@aws-sdk` kept only for presigned upload URLs
- **Inline scripts limitation** -- `<script is:inline>` and `<script define:vars>` blocks are not processed by Vite; must be plain JS (no TypeScript syntax)
- **`@xmldom/xmldom`** -- Required by `@aws-sdk` for XML parsing in Cloudflare Workers (no native `DOMParser`). Polyfilled in `src/lib/dom-polyfill.ts`.

## D1 Migrations

D1 schema changes use numbered SQL migrations in `database/migrations/` (e.g. `0001_create_tables.sql`, `0002_add_indexes.sql`).

- **Apply locally**: `npx wrangler d1 migrations apply freshwax-db --local`
- **Apply to production**: `npx wrangler d1 migrations apply freshwax-db --remote`
- **Caveat**: If the production database was initially created outside the migration system, `wrangler d1 migrations apply` may replay all migrations and fail on existing tables. In that case, apply new DDL directly: `npx wrangler d1 execute freshwax-db --remote --command="CREATE TABLE IF NOT EXISTS ..."`
- Migrations are tracked by Wrangler in a `d1_migrations` metadata table.

## Uptime Monitoring

The `/api/health/public/` endpoint returns a JSON health check (Firestore, D1, KV, R2 probes). The CI/CD pipeline hits this endpoint after every deployment with automatic rollback on failure.

For external uptime monitoring, point a service (e.g. UptimeRobot, Cloudflare Health Checks, or Better Uptime) at `https://freshwax.co.uk/api/health/public/` with a 60-second interval. Alert on non-200 responses or response times exceeding 5 seconds.
