# R26 Fix Plan — Target 95+ in Every Category

## Current Scores
| Category | Current | Target | Gap |
|---|---|---|---|
| Security | 63 | 95+ | 32+ |
| Performance | 62 | 95+ | 33+ |
| SEO | 72 | 95+ | 23+ |
| A11y | 62 | 95+ | 33+ |
| Errors | 72 | 95+ | 23+ |
| Code | 72 | 95+ | 23+ |
| Infra | 52 | 95+ | 43+ |

---

## WAVE 1: Security (63 → 95+) — 6 agents

### Agent 1A: CRITICAL — Stored XSS in live.astro (recovers +15)
- `src/pages/live.astro:2507` — escapeHtml on `slot.djName` in calendar innerHTML
- `src/pages/live.astro:2619` — escapeHtml on `displayName` in schedule h3
- `src/pages/live.astro:2621` — escapeHtml on `slot.title` in schedule title
- `src/pages/live.astro:2863` — escapeHtml on `slot.djName` in queue card
- NOTE: escapeHtml already exists in the same script scope — just call it

### Agent 1B: CRITICAL — Stored XSS in dj-mix tracklist + book.astro (recovers +10)
- `src/pages/dj-mix/[id].astro:2030` — escapeHtml on `track` in tracklist innerHTML
- `src/pages/dj-lobby/book.astro:1370` — escapeHtml on `slot.djName`, `slot.title`
- `src/pages/dj-lobby/book.astro:1374` — escapeHtml on data-attributes (attribute breakout)

### Agent 1C: HIGH — WHIP proxy fail-closed + supplier portal escaping (recovers +10)
- `src/pages/api/livestream/whip-proxy.ts:51-53` — change catch to DENY streaming (fail closed)
- `src/pages/supplier/portal.astro:462-470` — escapeHtml on `p.orderNumber`, `p.orderId`, `p.status`

### Agent 1D: MEDIUM — Firebase API key consolidation (recovers +5)
- Grep for hardcoded `AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g` across all files
- Replace with `import.meta.env.PUBLIC_FIREBASE_API_KEY` consistently
- Verify all 12+ locations

### Agent 1E: LOW — CORS localhost removal + wildcard tightening (recovers +4)
- `src/middleware.ts:46-48` — remove localhost origins from ALLOWED_ORIGINS
- `src/middleware.ts:55` — tighten `*.freshwax.pages.dev` wildcard (consider explicit list)
- `src/pages/api/log-error.ts` — add basic auth or tighter rate limiting
- `src/pages/api/consent-log.ts` — add basic auth or tighter rate limiting

### Agent 1F: MEDIUM — renderConditionBadge escaping (recovers +5)
- `src/pages/crates/[id].astro:1239` — escapeHtml on `abbr` in renderConditionBadge

---

## WAVE 2: A11y (62 → 95+) — 5 agents

### Agent 2A: CRITICAL — Add role="dialog" + aria-modal to 21 modals (recovers +8)
All modals with `class="modal hidden"` pattern need `role="dialog" aria-modal="true"`:
- live.astro: bookingModal, goLiveNowModal, shareModal, shoutoutModal
- account/mixes.astro: editModal, deleteModal
- admin/giftcards.astro: 3 modals
- admin/plus-accounts.astro: 2 modals
- admin/vinyl/listings.astro, admin/vinyl/index.astro, admin/streaming.astro: 5+
- admin/relay-sources.astro, admin/streaming/schedule.astro: 3
- ReleasePlate.astro: nyp-modal
- DailySchedule.astro: addDj, editSlot, allowances

### Agent 2B: CRITICAL — Comment textarea labels + vinyl track labels (recovers +16)
- `item/[id].astro:909` — add aria-label="Write a comment" to textarea
- `dj-mix/[id].astro:439` — add aria-label="Write a comment" to textarea
- `dj-mix/[id].astro:385` — add aria-label="Your name" to comment-username input
- `artist/vinyl/new.astro:509-517` — add aria-label to innerHTML-created track inputs
- `artist/vinyl/new.astro:355` — add aria-label to description textarea

### Agent 2C: HIGH — 19 more modal close buttons + admin filter labels (recovers +10)
Close buttons needing aria-label="Close":
- live.astro:707,901,952
- account/mixes.astro:79,156
- artist/vinyl/new.astro:168
- admin/inventory/index.astro:253
- admin/payments.astro:856,872,888
- admin/reports.astro:74
- admin/orders.astro:298,583
- admin/vinyl/listings.astro:231
- admin/plus-accounts.astro:238,252
- admin/vinyl/index.astro:405
- admin/streaming/schedule.astro:80,143
- ReleasePlate.astro:798
Admin filter labels:
- admin/inventory/index.astro:123,131,167,173,227 — add aria-label to selects
- admin/vinyl/listings.astro:102,113 — add aria-label to filter selects
- dj-mixes.astro:561 — add aria-label to share link input

### Agent 2D: MEDIUM — Table captions, heading fixes, admin labels (recovers +6)
- 21 tables: add aria-label (e.g., `aria-label="Shipping rates"`) to each <table>
- login.astro: remove duplicate H1 (keep sr-only, remove visual H1 or combine)
- account/mixes.astro: fix conditional H1 duplicates
- checkout/success.astro: fix triple H1 (use H2 for secondary states)
- admin/settings.astro: add aria-label to 10+ unlabeled selects

### Agent 2E: MEDIUM — Reduced motion coverage (recovers +3)
Add `@media (prefers-reduced-motion: reduce) { animation: none !important; transition: none !important; }` to:
- merch.css, dj-mixes.css, giftcards.css, checkout.css, dashboard.css
- admin-global.css (if not already covered)

---

## WAVE 3: Performance (62 → 95+) — 6 agents

### Agent 3A: CRITICAL — Batch artist fetches in payment capture (recovers +16)
- `paypal/capture-order.ts:599` — collect all artistIds, batch fetch with Promise.all + Map before loop
- `paypal/capture-redirect.ts:299` — same pattern
- Follow the pattern already in `trigger-payout.ts:187-213`

### Agent 3B: CRITICAL — Batch stock-reservation + vinyl-processing fetches (recovers +16)
- `stock-reservation.ts` — collect all item IDs upfront, batch getDocument with Promise.all, then process from Map
- `vinyl-processing.ts:109` — same batch-fetch-before-loop pattern

### Agent 3C: CRITICAL — DailySchedule batch slot booking (recovers +8)
- `DailySchedule.astro:1699` — replace sequential `await fetch` loop with single API call
- Create `/api/livestream/slots/batch/` endpoint accepting array of slots
- Or use Promise.all to parallelize existing calls

### Agent 3D: HIGH — Minify public JS files via Vite (recovers +10)
- `public/live-stream.js` (149KB) — move to src/ and import via regular `<script>` for Vite processing
- `public/dj-lobby/*.js` (147KB total) — same treatment
- Or add a build step to minify public/ files
- Delete `public/freshwax-cart.unmin.js` (dead/debug code)

### Agent 3E: MEDIUM — Duplicate keyframe naming (recovers +3)
Rename colliding @keyframes to unique names:
- `pulse-glow` → `pulse-glow-schedule` (DailySchedule), `pulse-glow-shuffle` (FloatingShuffleButton), `pulse-glow-preorder` (ReleasePlate)
- `pulse` → `pulse-opacity` (global), `pulse-shimmer` (GlobalAudioPlayer), `pulse-sale-glow` (pre-orders), `pulse-scale` (embed)
- `fadeIn` → keep global, rename FAQ's to `fadeSlideIn`
- `fadeInUp` → keep global, rename index's to `fadeInUpHero`
- Update corresponding animation: properties

### Agent 3F: LOW — srcset on product images + console.error cleanup (recovers +3)
- Add srcset with 400w/800w variants on item/[id], dj-mix/[id], merch/[id] product images
- Replace console.error with createLogger in index.astro:18, order-confirmation/[id].astro:32, admin/merch/edit/[id].astro:106

---

## WAVE 4: Errors (72 → 95+) — 4 agents

### Agent 4A: HIGH — Client-side fetch timeouts + IdempotencyError fix (recovers +10)
- playlist-manager.ts:2210,2228,2245,2301 — add AbortController with 10s timeout to external fetch calls
- playlist-modal-init.ts:1567 — same
- webhook.ts:177,194,209,228 — replace IdempotencyError.message with generic "Idempotency check failed"

### Agent 4B: HIGH — Client-side JSON.parse protection (recovers +5)
- merch.astro:791,833,905 — wrap JSON.parse in try/catch
- dj-mixes.astro:1443,1461 — wrap JSON.parse in try/catch
- Any other client-side JSON.parse without individual try/catch

### Agent 4C: MEDIUM — Bare catch blocks → bind error variable (recovers +3)
- Convert 26 bare `catch {}` blocks to `catch (e) {}` (in .astro inline) or `catch (_e: unknown) {}` (in .ts) with comment
- The 11 empty `.catch(() => {})` → `.catch(() => { /* non-critical: KV cache */ })` with comments

### Agent 4D: MEDIUM — Promise.allSettled on batch operations (recovers +3)
- create-order.ts:370 item enrichment — consider allSettled with per-item fallback
- capture-order.ts:351 — same
- complete-free-order.ts:321 — same
- product-order.ts:358 — same

---

## WAVE 5: Code Quality (72 → 95+) — 4 agents

### Agent 5A: HIGH — Fix abandoned-cart.ts dangerous double casts (recovers +20)
- `abandoned-cart.ts:44,54,57,76` — fix the 4 `as unknown as <wrong type>` casts
- Read the actual function signatures of getDocument/queryCollection and pass correct parameters
- The env object is being passed where different types are expected — restructure the calls

### Agent 5B: MEDIUM — Delete dead code + fix dom-polyfill (recovers +6)
- Delete `public/freshwax-cart.unmin.js`
- Fix dom-polyfill.ts `as any` — use proper globalThis type augmentation:
  ```typescript
  declare global { var DOMParser: typeof import('...').DOMParser; }
  ```
- Remove ~255 commented-out code blocks across API files (be selective — only truly dead code)

### Agent 5C: MEDIUM — Empty .catch blocks + analytics frontmatter (recovers +6)
- 11 empty `.catch(() => {})` — add descriptive comments
- `admin/analytics.astro` — replace 7 console.error/debug with createLogger in frontmatter
- `as unknown as` double casts: fix embed-player.ts:415, dj-support.ts:219, r2-firebase-sync.ts:52-53, webhook.ts:158,303,311

### Agent 5D: LOW — Deep import paths + client-side logging (recovers +2)
- Consider adding tsconfig path alias `@lib` → `src/lib` (Astro supports this)
- Or document that deep imports are acceptable for this project structure

---

## WAVE 6: SEO (72 → 95+) — 4 agents

### Agent 6A: HIGH — Fix orphaned pages + internal linking (recovers +15)
- Add /samples/ to Header or Footer navigation
- Add /newsletter/ link to Footer (alongside the inline form)
- Add /schedule/ to Header or Footer navigation
- These 3 pages are in the sitemap but have zero nav links

### Agent 6B: HIGH — Fix duplicate H1s + missing canonicals (recovers +10)
- login.astro: remove one of the two H1s (keep sr-only, change visual to H2 or merge)
- checkout/success.astro: change secondary state H1s to H2
- Add canonical URL to login, register, forgot-password, verify-email, dj-lobby/book
- Even noindex pages benefit from canonical signals

### Agent 6C: MEDIUM — Title optimization + descriptions (recovers +9)
- Expand short titles: samples (24→50+ chars), blog (36→50+), shipping (29→50+), contact (36→50+)
- Fix crates title (61→60 chars max)
- Add descriptions to checkout/success, order-confirmation/[id], unsubscribe
- Homepage H1: incorporate keywords (e.g., "Fresh Wax — Jungle & Drum and Bass Music")
- Fix merch/[id] short description fallback

### Agent 6D: LOW — Cleanup deprecated meta + sitemap fix (recovers +5)
- Remove `<meta name="keywords">` from SEO.astro (deprecated by Google since 2009)
- Remove `<meta http-equiv="x-ua-compatible">` (IE is dead)
- Remove or fix ICBM coordinates (generic London location)
- Remove artist query-param URLs from sitemap.xml.ts
- Fix SearchAction urlTemplate conflict with robots.txt

---

## WAVE 7: Infrastructure (52 → 95+) — 6 agents

### Agent 7A: CRITICAL — Add ESLint to project + CI (recovers +10)
- Install eslint + @typescript-eslint/parser + @typescript-eslint/eslint-plugin
- Create eslint.config.js with recommended rules
- Add `"lint": "eslint src/"` to package.json
- Add lint step to deploy.yml before build
- Add lint to validate script

### Agent 7B: CRITICAL — Payment path tests (recovers +10)
- Write endpoint-level tests for create-order.ts (mock Stripe/Firebase, test full flow)
- Write endpoint-level tests for create-checkout-session.ts
- Write test for capture-order.ts endpoint flow
- Focus on happy path + error cases + idempotency

### Agent 7C: CRITICAL — E2E in CI + coverage gates (recovers +10)
- Add Playwright step to deploy.yml (after build, using Cloudflare preview URL or local server)
- Add coverage collection: `vitest run --coverage`
- Add coverage threshold in vitest.config.ts: `thresholds: { lines: 50 }`
- Upload coverage report as CI artifact

### Agent 7D: CRITICAL — npm audit blocking + rollback (recovers +10)
- deploy.yml: change `|| echo` to fail on HIGH vulnerabilities
- Add post-deploy health check that triggers rollback on failure
- Document rollback procedure in README
- Add `wrangler pages deployment rollback` step if health check fails

### Agent 7E: HIGH — Environment variable alignment (recovers +5)
- Add PUBLIC_GA4_MEASUREMENT_ID to env.d.ts ImportMetaEnv and CloudflareEnv
- Audit all .env.example vars against env.d.ts — fix any other mismatches
- Move GIPHY key from wrangler.toml [vars] to Cloudflare dashboard secret
- Remove D1 database_id from wrangler.toml (use env var)

### Agent 7F: MEDIUM — Monitoring + staging (recovers +6)
- Add Cloudflare Notifications for: 5xx rate, webhook failures
- Configure Cloudflare Web Analytics (free, no JS tag needed for Workers)
- Add staging deployment to deploy.yml (deploy to freshwax-staging first, test, then production)
- Make Lighthouse CI assertions use "error" severity instead of "warn"
- Add concurrency control to lighthouse-ci.yml

---

## Execution Order

**Phase 1 (Waves 1-2): Security + A11y** — 11 agents in parallel
These are the highest-impact fixes with the most user-facing risk.

**Phase 2 (Waves 3-4): Performance + Errors** — 10 agents in parallel
Server-side optimizations and error handling hardening.

**Phase 3 (Waves 5-6): Code + SEO** — 8 agents in parallel
Code quality and search engine optimization.

**Phase 4 (Wave 7): Infrastructure** — 6 agents in parallel
CI/CD, testing, monitoring improvements.

## Verification After Each Phase
- `npm run build` — zero errors
- `npx vitest run` — all tests pass
- Git commit per phase

## Total: 35 agents across 7 waves in 4 phases
