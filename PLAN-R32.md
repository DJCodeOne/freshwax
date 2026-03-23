# R32 Fix Plan — Target 95+ in Every Category

## Current Scores (R32 Ultra-Strict Audit, Mar 22 2026)
| Category | Current | Target | Gap |
|---|---|---|---|
| Security | 98 | 95+ | Already above |
| SEO | 96 | 95+ | Already above |
| A11y | 88 | 95+ | -7 |
| Errors | 84 | 95+ | -11 |
| Infrastructure | 80 | 95+ | -15 |
| Performance | 65 | 95+ | -30 |
| Code Quality | 58 | 95+ | -37 |

---

## WAVE 1: Code Quality (58 → 95+) — 6 agents

### Agent 1A: Split playlist-modal-init.ts (2043 lines) (+4)
Split into focused modules:
- `src/lib/playlist-modal/types.ts` — interfaces
- `src/lib/playlist-modal/dom.ts` — DOM manipulation, rendering
- `src/lib/playlist-modal/api.ts` — fetch calls, data loading
- `src/lib/playlist-modal/events.ts` — event handlers
- `src/lib/playlist-modal/index.ts` — barrel re-export
Keep `playlist-modal-init.ts` as thin orchestrator (<300 lines)

### Agent 1B: Split checkout-client.ts (1637 lines) + playlist-manager.ts (1452 lines) (+4)
checkout-client.ts → extract:
- `src/lib/checkout/stripe-client.ts` — Stripe-specific logic
- `src/lib/checkout/paypal-client.ts` — PayPal-specific logic
- `src/lib/checkout/cart-validation.ts` — price/stock validation
- `src/lib/checkout/checkout-ui.ts` — DOM updates, form handling

playlist-manager.ts → extract:
- `src/lib/playlist/playback.ts` — audio playback control
- `src/lib/playlist/queue.ts` — queue management
- `src/lib/playlist/ui.ts` — DOM rendering

### Agent 1C: Split remaining 10 files >500 lines (+4)
Files 500-600 lines — extract largest functions:
- `embed-player.ts` (866) → extract player/rendering modules
- `stripe-webhook/product-order.ts` (591) → extract email/notification helpers
- `order/emails.ts` (543) → split by email type
- `order/stock-reservation.ts` (542) → extract cleanup to separate file
- `stripe-webhook/subscriptions.ts` (525) → extract common patterns
- `api/livestream/chat.ts` (566) → extract message handling
- `api/playlist/global.ts` (564) → extract helpers
- `api/admin/giftcards.ts` (531) → extract validation
- `api/admin/create-manual-order.ts` (528) → extract builder
- `api/roles/manage.ts` (504) → extract role checks

### Agent 1D: TIMEOUTS constant migration + magic numbers (+9)
Replace ALL 64 raw timeout numbers with `TIMEOUTS.*` constants:
- Grep `fetchWithTimeout\([^,]+,\s*\d+\)` across all .ts files
- Replace `10000` → `TIMEOUTS.API`, `5000` → `TIMEOUTS.SHORT`, `30000` → `TIMEOUTS.LONG`
- Replace `15000` → `TIMEOUTS.PAYMENT` (or create if needed)
- Also fix remaining hardcoded query limits, cache TTLs, pagination sizes

### Agent 1E: Eliminate duplicate patterns + dead code (+6)
1. Extract Firebase env setup boilerplate (~40 admin endpoints) to shared `getAdminFirebaseContext(locals)` helper
2. Remove commented-out SQL DDL blocks in webhook.ts and other files
3. Replace `@ts-ignore` in image-processing.ts with `@ts-expect-error` with explanation
4. Fix inconsistent raw `fetch` in `error-alerting.ts` → `fetchWithTimeout`
5. Fix inconsistent `new Response` in `release/artwork.ts` → `errorResponse`

### Agent 1F: Tests + Zod validation (+9)
1. Add stock-reservation.ts tests — optimistic concurrency, expiry, cleanup (-3 recovered)
2. Add livestream booking tests — slot validation, conflict detection (-3 recovered)
3. Add Zod schemas to remaining ~5 admin JSON endpoints without validation (-3 recovered)

---

## WAVE 2: Performance (65 → 95+) — 6 agents

### Agent 2A: CSS file size reduction (+8)
Audit and reduce 4 CSS files >80KB:
1. `dj-lobby.css` (~120KB) — remove dead selectors, consolidate duplicate media queries
2. `live.css` (~100KB) — remove dead selectors, consolidate animations
3. `merch.css` (~100KB) — remove dead selectors
4. `giftcards.css` (~100KB) — remove dead selectors
Target: each file under 80KB

### Agent 2B: Extract dj-lobby.astro inline JS (+3)
`src/pages/account/dj-lobby.astro` has ~5000 lines of inline JS (~150KB in HTML).
Extract remaining functions into `public/dj-lobby/*.js` modules using the existing `init(ctx)` pattern.
Target: inline JS <500 lines (orchestration only)

### Agent 2C: Split live-stream.js (100KB) (+4)
Split `public/live-stream.js` into focused modules:
- `public/live/hls-player.js` — HLS.js setup, playback
- `public/live/pusher-events.js` — Pusher event handlers
- `public/live/chat-handler.js` — chat rendering, sending
- `public/live/ui-controls.js` — volume, fullscreen, mobile
Keep `live-stream.js` as thin orchestrator importing modules

### Agent 2D: Client-side fetch timeouts for 19 public JS files (+8)
Add AbortController timeout to ALL fetch() calls in public/*.js files:
- `freshwax-cart.js`, `item-page.js`, `cart-page.js`, `newsletter-form.js`
- `email-verify-check.js`, `csrf-protect.js`, `audio-player-init.js`
- `dj-lobby/chat.js`, `dj-lobby/dm.js`, `dj-lobby/scheduling.js`, `dj-lobby/share.js`
- `dashboard/orders.js`, `dashboard/social.js`, `dashboard/mixes.js`, `dashboard/downloads.js`
- `dashboard/credits.js`, `dashboard/subscription.js`, `dashboard/profile.js`
- `live/reactions.js`
Pattern: `const c = new AbortController(); setTimeout(() => c.abort(), 15000); fetch(url, { signal: c.signal })`
NOTE: These are plain JS files — NO TypeScript syntax.

### Agent 2E: Remove Firebase client SDK imports (+2)
- `public/item-page.js` — dynamic imports of firebase-app.js + firebase-auth.js for `checkUserPurchasePermission`. Replace with REST API auth pattern (read __session cookie, call /api/auth/verify-token/ endpoint).
- `public/dj-lobby-pusher.js` — dynamic import of firebase-auth.js for auth token. Replace with cookie-based auth.

### Agent 2F: N+1 + sequential fetch fixes (+5)
1. `api/cron/send-restock-notifications.ts` — batch Resend emails instead of loop (-3)
2. `api/stripe/verify-session.ts` — parallelize line items fetch + order query with Promise.all (-2)
3. Add srcset to dynamically-generated images in `cart-page.js` and `item-page.js`
4. Fix remaining missing Cache-Control headers on 2-3 pages

---

## WAVE 3: Errors (84 → 95+) — 3 agents

### Agent 3A: Missing .ok checks + fetch timeouts (+8)
1. Add `.ok` check before `.json()` on 5 admin page fetch calls:
   - `admin/merch/manage.astro:432,457`
   - `admin/merch/edit/[id].astro:633,1585`
   - `admin/plus-accounts.astro:605`
2. Add `.ok` check on `public/dj-lobby/scheduling.js:70,92`
3. Add AbortController timeout on `public/dj-lobby/chat.js:38` and `scheduling.js:69,91`
4. Fix `error-alerting.ts:85` — use fetchWithTimeout instead of raw fetch
NOTE: .astro and .js files — NO TypeScript syntax in inline scripts.

### Agent 3B: Error message leakage + Promise.allSettled (+5)
1. Strip `e.message` from responses in:
   - `delete-account.ts:146-290` — use generic "Deletion step failed"
   - `admin/cleanup-duplicates.ts:179` — use generic message
   - `admin/test-order-email.ts:140` — use generic message
   - `admin/send-artist-notification.ts:230,233` — use generic message
   - `admin/health-check.ts:271` — keep for admin but redact stack traces
2. Convert `Promise.all` → `Promise.allSettled` in `admin/backfill-ledger.ts:116,134`

### Agent 3C: D1, Firebase, PayPal resilience (+3)
1. Add SQLITE_BUSY retry logic to D1 operations — create `withD1Retry(fn, maxRetries=3)` helper
2. Add 429 handling to Firebase REST queries — retry after 1s on RESOURCE_EXHAUSTED
3. Add single retry with 2s backoff on PayPal API transient failures (503, network error)

---

## WAVE 4: A11y (88 → 95+) — 2 agents

### Agent 4A: Quick a11y fixes (+10)
1. **Autocomplete attrs** (-4 recovered): Add `autocomplete="email"` and `autocomplete="name"` to:
   - `newsletter.astro:38` (name), `newsletter.astro:47` (email)
   - `unsubscribe.astro:37` (email)
   - `Footer.astro:78-84` (newsletter email)
2. **Skip links** (-2 recovered): Add "Skip to main content" to 4 standalone pages:
   - `account/dj-lobby.astro`, `dj-lobby/book.astro`, `verify-email.astro`, `forgot-password.astro`
3. **Touch targets** (-2 recovered): Increase `.chat-tool-btn` from 36px to 44px min in LiveChat.astro
4. **PWA contrast** (-2 recovered): Change PWA install banner text from `#999` to `#ccc` on `#111` bg

### Agent 4B: Heading hierarchy + table captions (+4)
1. **H1→H3 skip** (-2 recovered): Fix `live.astro` LiveChat heading — change H3 to H2 in LiveChat.astro
2. **Table captions** (-2 recovered): Add `<caption class="sr-only">` to admin data tables (top 20 most important tables)

---

## WAVE 5: Infrastructure (80 → 95+) — 3 agents

### Agent 5A: Staging deployment + E2E in CI (+8)
1. Create staging Cloudflare Pages project config
2. Add `deploy-staging` job in deploy.yml between validate and deploy
3. Add Playwright E2E smoke tests against staging URL in CI
4. Add environment protection rules for production deployment
5. Wire `npm run test:e2e` to CI after staging deploy

### Agent 5B: Coverage thresholds + test gaps (+5)
1. Run `npx vitest run --coverage` to get actual coverage numbers
2. Set thresholds to 80% of actual (prevent regressions)
3. Add `create-order.ts` integration tests for the critical payment path
4. Promote `no-floating-promises` from `warn` to `error` in eslint.config.js

### Agent 5C: Cleanup + documentation (+7)
1. Remove `@xmldom/xmldom` dependency (or document justification)
2. Remove phantom `PUBLIC_VINYL_API_URL` from .env.example and env.d.ts
3. Move `PUBLIC_FIREBASE_API_KEY` from wrangler.toml [vars] to CF dashboard comment
4. Add migration strategy documentation (README or MIGRATIONS.md)
5. Add `weekly-digest` to README cron table
6. Add CONTRIBUTING.md with code style guide, PR template
7. Document uptime monitoring setup in README
8. Delete acknowledged dead code (if any remains)

---

## Execution Order

**Phase 1 (Wave 1): Code Quality** — 6 agents sequentially
Biggest gap (58). File splits, constant migration, tests.

**Phase 2 (Wave 2): Performance** — 6 agents sequentially
Second biggest gap (65). CSS reduction, JS splits, fetch timeouts.

**Phase 3 (Wave 3): Errors** — 3 agents sequentially
.ok checks, error leakage, resilience.

**Phase 4 (Waves 4-5): A11y + Infrastructure** — 5 agents sequentially
Polish and CI/CD.

## Verification After Each Phase
- `npm run build` — zero errors
- `npx vitest run` — all tests pass
- Git commit per phase

## Total: 20 agents across 5 waves in 4 phases

## Expected Final Scores
| Category | Current | Expected |
|---|---|---|
| Security | 98 | 98+ (no changes needed) |
| SEO | 96 | 96+ (no changes needed) |
| A11y | 88 | 98+ |
| Errors | 84 | 97+ |
| Infrastructure | 80 | 100 |
| Performance | 65 | 95+ |
| Code Quality | 58 | 95+ |
