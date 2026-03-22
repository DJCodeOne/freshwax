# R31 Fix Plan — Target 95+ in Every Category

## Current Scores (R31 Ultra-Strict Audit, Mar 22 2026)
| Category | Current | Target | Gap |
|---|---|---|---|
| Security | 63 | 95+ | 32+ |
| Performance | 58 | 95+ | 37+ |
| SEO | 74 | 95+ | 21+ |
| A11y | 72 | 95+ | 23+ |
| Errors | 85 | 95+ | 10+ |
| Code Quality | 67 | 95+ | 28+ |
| Infrastructure | 71 | 95+ | 24+ |

---

## WAVE 1: Security (63 → 95+) — 4 agents

### Agent 1A: Cookie HttpOnly + CSP unsafe-inline removal (+16)
1. **__session cookie HttpOnly** (-3×2 = -6 recovered):
   - `src/components/Header.astro` and `src/layouts/AdminLayout.astro` set `__session` via `document.cookie`
   - Move session cookie setting to server-side Set-Cookie header with HttpOnly flag
   - Create `/api/auth/set-session/` endpoint that sets the cookie server-side
   - Client calls this endpoint after Firebase auth instead of setting cookie directly
2. **userId/customerId/partnerId HttpOnly** (-3 + -2 = -5 recovered):
   - These are used for SSR pre-fetching. Move to server-side Set-Cookie as well
   - Update `Header.astro`, `dashboard.astro` to use the new endpoint
3. **CSP unsafe-inline removal** (-5 recovered):
   - User says "ignore Astro limitations"
   - Remove `'unsafe-inline'` from script-src entirely. Keep `'nonce-{nonce}' 'strict-dynamic'`
   - Add nonce attribute to ALL `<script>` tags in Layout.astro, AdminLayout.astro, etc.
   - For Astro-inlined scripts that can't receive nonces: move them to external .js files loaded with nonce
   - Test thoroughly — some scripts may break

### Agent 1B: Newsletter XSS + admin formatAddress (+8)
1. **renderMarkdown() XSS** (-5 recovered):
   - `src/pages/admin/newsletter.astro` line 796: `renderMarkdown()` converts markdown to HTML without sanitization
   - Link regex allows `javascript:` protocol in href
   - Fix: sanitize href in renderMarkdown — only allow `http:`, `https:`, `mailto:` protocols
   - Escape all other user-supplied values in the markdown output
2. **Admin formatAddress() XSS** (-5 recovered but -2 remaining):
   - `src/pages/admin/orders.astro` line 464: shipping addresses rendered via innerHTML
   - Verify formatAddress() calls escapeHtml() on each address field
   - If not, add escapeHtml() to all address components

### Agent 1C: Error viewer info leak + D1 query hardening (+5)
1. **Admin error viewer** (-3 recovered):
   - `src/pages/admin/errors.astro` exposes stack traces, file paths, IPs
   - Add admin-only auth check (already there via AdminLayout)
   - Truncate stack traces to first 3 lines, redact file paths, hash IPs
2. **D1 backup SQL interpolation** (-2 recovered):
   - `src/pages/api/cron/backup-d1.ts` line 58: PAGE_SIZE interpolated into SQL
   - Change to parameterized query: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?` with `.bind(PAGE_SIZE, offset)`
   - Note: tableName can't be parameterized but is validated against whitelist

---

## WAVE 2: Performance (58 → 95+) — 5 agents

### Agent 2A: CSS file size reduction (+6)
1. **dj-lobby.css 160KB → <80KB** (-2 recovered):
   - Audit ALL selectors against actual dj-lobby.astro usage
   - Remove unused selectors, merge duplicate media queries
   - Extract animations to shared file
2. **live.css 143KB → <80KB** (-2 recovered):
   - Same audit against live.astro
3. **dashboard.css 119KB → <80KB** (-2 recovered):
   - Audit against dashboard.astro + admin pages

### Agent 2B: live-stream.js memory leaks + size (+18)
1. **Split live-stream.js** (-2 recovered): 55KB monolith → 3-4 focused modules
2. **startDurationTimer interval leak** (-3 recovered): Store ref, clear on cleanup
3. **joinStream heartbeat interval leak** (-3 recovered): Store ref, clear on disconnect
4. **setupHlsPlayer addEventListener accumulation** (-3 recovered): Track and remove before re-adding
5. **setupMobileFeatures window listeners** (-3 recovered): Add astro:before-swap cleanup
6. **setupTouchVolumeControl listeners** (-3 recovered): Add cleanup
7. **setupVolumeSlider listeners** (-3 recovered): Add cleanup

### Agent 2C: Missing srcset on listing pages (+4)
1. **merch/[id].astro** (-1): Add srcset to product images
2. **merch.astro** (-1): Add srcset to listing images
3. **dj-mixes.astro** (-1): Add srcset to mix carousel images
4. **crates.astro** (-1): Add srcset to crate listing images

### Agent 2D: Client-side fetch timeouts (+12)
Add AbortController timeouts to ALL client-side fetch() calls:
1. **checkout-client.ts** (-2): 11 bare fetch calls
2. **playlist-manager.ts** (-2): 9 bare fetch calls
3. **checkout/paypal.ts** (-2): 3 bare fetch calls
4. **checkout/validation.ts** (-2): 4 bare fetch calls
5. **checkout/stripe.ts** (-2): 3 bare fetch calls
6. **playlist-modal-init.ts** (-2): 4 bare fetch calls
Pattern: `const controller = new AbortController(); setTimeout(() => controller.abort(), 15000); fetch(url, { signal: controller.signal })`
NOTE: These are Vite-processed .ts files, TypeScript syntax is fine.

### Agent 2E: live-stream.js client fetch timeouts (+2)
- Add AbortController to all fetch calls in public/live-stream.js
- NOTE: This is plain JS (not TypeScript). No `: unknown` etc.

---

## WAVE 3: SEO (74 → 95+) — 3 agents

### Agent 3A: Heading hierarchy fixes (+8)
1. **newsletter.astro** (-2): Fix H1→H3 skip, add H2 between
2. **dj-mixes.astro** (-2): Fix H1→H3 skip on mix cards — use H2 for card titles
3. **live.astro** (-2): Fix inconsistent heading hierarchy
4. **dj-lobby.astro** (-1): Remove extra H1s, keep only one
5. **artist/dashboard.astro** (-1): Remove extra H1s
6. **artist/merch-analytics.astro** (-1): Remove extra H1

### Agent 3B: Schema + canonical + OG fixes (+9)
1. **crates/[id].astro priceValidUntil** (-3): Add to Product schema
2. **verify-email.astro canonical** (-3): Add canonical URL via SEO component
3. **login.astro OG tags** (-2): Add og:title, og:description, og:type
4. **register.astro OG tags** (-2): Add og tags
5. **forgot-password.astro OG tags** (-1): Add og tags

### Agent 3C: CLS + content fixes (+5)
1. **crates/[id].astro H1 "Loading..."** (-3): Render actual product title server-side, not "Loading..."
2. **crates/[id].astro CLS** (-2): Fix display:none→shown content shift — use CSS containment or reserve space
3. **crates/[id].astro short description** (-1): Ensure generated description meets 50 char minimum
4. **contact.astro title** (-1): Trim to under 60 chars

---

## WAVE 4: A11y (72 → 95+) — 4 agents

### Agent 4A: Button labels + touch targets (+10)
1. **book.astro prevDay/nextDay buttons** (-3×2 = -6): Add aria-label="Previous day" and "Next day"
2. **dj-mix/[id].astro emoji buttons** (-2): Add min-width/min-height 44px
3. **item/[id].astro emoji buttons** (-2): Add min-width/min-height 44px
4. **upload-mix.astro emoji buttons** (-2): Add padding/min-size for 44px touch target

### Agent 4B: Focus indicators in admin (+6)
1. **admin/blog/edit/index.astro** (-3): Replace focus:outline-none with :focus-visible outline
2. **admin/blog/edit/[id].astro** (-3): Same fix for all inputs

### Agent 4C: Missing landmarks + contrast (+7)
1. **dj-lobby/book.astro missing main** (-3): Wrap content in `<main>`
2. **account/dj-lobby.astro missing main** (-3): Wrap content in `<main>`
3. **admin-global.css text-gray-500** (-2×2 = -4): Replace with text-gray-300 for contrast

---

## WAVE 5: Errors (85 → 95+) — 2 agents

### Agent 5A: Promise.all → allSettled (+8)
1. **stock-validation.ts** (-2×3 = -6): Convert 3 Promise.all to Promise.allSettled with proper result handling
2. **vinyl-processing.ts** (-2): Convert Promise.all to Promise.allSettled

### Agent 5B: Pusher .ok check + webhook error messages (+5)
1. **playlist/helpers.ts Pusher fetch** (-3): Add .ok check before .text()
2. **webhook.ts error messages** (-4×1 = -4): Replace error.message with generic messages in Stripe webhook error responses (lines 177, 194, 209, 228)

---

## WAVE 6: Code Quality (67 → 95+) — 4 agents

### Agent 6A: Split large files (+20)
Files >500 lines to split:
1. **d1-catalog.ts** (~1489 lines) → d1-catalog/queries.ts, d1-catalog/mutations.ts, d1-catalog/migrations.ts, d1-catalog/index.ts
2. **capture-redirect.ts** (~900 lines) → extract shared helpers to lib/order/paypal-redirect-helpers.ts
3. **dj-lobby.astro frontmatter** — extract data fetching to lib/dj-lobby-data.ts
4. **live.astro frontmatter** — extract data fetching to lib/live-data.ts
5. **Any remaining .ts files >500 lines** — identify and split

### Agent 6B: Eliminate duplicate code (+15)
Grep for and deduplicate:
1. Functions defined in multiple files
2. Repeated patterns >10 lines that should be extracted
3. Dead exports and unused functions
4. Commented-out code blocks >5 lines

### Agent 6C: Magic numbers → constants (+5)
1. Replace ALL remaining hardcoded timeouts (not just the TIMEOUTS ones) with named constants
2. Replace retry counts, cache TTLs, pagination limits with named constants
3. Create `src/lib/constants/limits.ts` for business logic constants

### Agent 6D: Import path aliases (+3)
1. Count `../../../../..` relative imports
2. Configure tsconfig paths alias (e.g., `@lib/`, `@components/`, `@pages/`)
3. Update the deepest relative imports to use aliases

---

## WAVE 7: Infrastructure (71 → 95+) — 3 agents

### Agent 7A: TypeScript + ESLint hardening (+8)
1. **noUncheckedIndexedAccess** (-3): Enable in tsconfig.json. Fix resulting errors.
2. **ESLint for .astro** (-3): Add astro-eslint-parser for frontmatter linting
3. **Type-aware ESLint** (-2): Add parserOptions.project for no-floating-promises rule

### Agent 7B: Staging + deployment fixes (+10)
1. **Staging environment** (-5): Document staging deployment to Cloudflare Pages preview branch. Add `npm run deploy:staging` script.
2. **Deploy script** (-2): Add `npm run deploy` for local manual deployments
3. **Cron triggers in code** (-2): Document cron schedules in wrangler.toml comments (even if not applicable for Pages)
4. **D1 migration numbering** (-2): Fix duplicate 0001_*.sql files

### Agent 7C: Health + monitoring (+5)
1. **Public health endpoint** (-2): Add service connectivity checks (D1 read, KV read) to /api/health/public/
2. **Error alerting** (-3): Add webhook notification on error spike (e.g., Slack/Discord webhook when D1 error count > threshold in last hour)
3. **Env var cleanup** (-2): Remove PUBLIC_TENOR_API_KEY from .env.example, fix PUBLIC_GA4_ID naming

---

## Execution Order

**Phase 1 (Waves 1-2): Security + Performance** — 9 agents
Biggest gaps. Run sequentially to avoid rate limits.

**Phase 2 (Waves 3-4): SEO + A11y** — 7 agents
User-facing improvements.

**Phase 3 (Waves 5-6): Errors + Code Quality** — 6 agents
Type safety and resilience.

**Phase 4 (Wave 7): Infrastructure** — 3 agents
CI/CD and tooling.

## Verification After Each Phase
- `npm run build` — zero errors
- `npx vitest run` — all tests pass
- Git commit per phase

## Total: 25 agents across 7 waves in 4 phases

## Expected Final Scores
| Category | Current | Expected |
|---|---|---|
| Security | 63 | 96+ |
| Performance | 58 | 96+ |
| SEO | 74 | 97+ |
| A11y | 72 | 95+ |
| Errors | 85 | 98+ |
| Code Quality | 67 | 95+ |
| Infrastructure | 71 | 95+ |
