# R29 Fix Plan — Target 95+ in Every Category

## Current Scores (R29 Audit, Mar 22 2026)
| Category | Current | Target | Gap |
|---|---|---|---|
| Security | 71 | 95+ | 24+ |
| Performance | 72 | 95+ | 23+ |
| SEO | 83 | 95+ | 12+ |
| A11y | 72 | 95+ | 23+ |
| Errors | 73 | 95+ | 22+ |
| Code Quality | 62 | 95+ | 33+ |
| Infrastructure | 87 | 95+ | 8+ |

---

## WAVE 1: Errors (73 → 95+) — 4 agents

### Agent 1A: Client-side .ok checks on all fetch calls (+12)
Grep all .astro files for `fetch(` followed by `.json()` without `.ok` check. Fix ALL:
- `src/pages/dj-mix/[id].astro` — 4 fetches (update-mix, giphy trending, giphy search, add-mix-comment)
- `src/pages/checkout/success.astro` — verify-session fetch (CRITICAL — payment flow)
- `src/pages/dj-lobby/book.astro` — 4 livestream/slots fetches
- `src/pages/account/selling.astro` — 3 parallel fetches + Stripe/PayPal connect
- `src/pages/account/streaming-setup.astro` — 2 fetches (get-user-type, relay-sources)
- Pattern: add `if (!response.ok) { console.error('...'); return; }` before `.json()`
- NOTE: These are `<script is:inline>` — NO TypeScript syntax

### Agent 1B: Client-side try/catch on all fetch calls (+8)
Wrap ALL client-side fetch() calls in try/catch blocks:
- `src/pages/dj-mix/[id].astro` — track-mix-play, track-mix-like, track-mix-unlike, track-mix-download, add-mix-comment (×2)
- `src/pages/account/selling.astro` — all 5 fetch calls
- `src/pages/account/streaming-setup.astro` — 2 fetch calls
- Pattern: `try { const res = await fetch(...); if (!res.ok) return; ... } catch(e) { /* silently fail */ }`
- NOTE: These are `<script is:inline>` — NO TypeScript syntax, NO `: unknown`

### Agent 1C: Empty catch blocks — add logging (+3)
Grep for catch blocks with empty body or just comments. Add minimal logging:
- Pattern: `catch (_e) { /* Non-critical: localStorage/auth/cache */ }` is OK
- Pattern: `catch (e) {}` with NO comment — add descriptive comment
- Focus on src/pages/ .astro client scripts only (server-side already done)
- Target: 0 empty catch blocks without at least a descriptive comment

### Agent 1D: API-side .ok checks on admin debug endpoints (+2)
- `src/pages/api/admin/debug-update-user.ts` — 3 missing .ok checks (lines 44, 97, 106)
- `src/pages/api/admin/add-artist.ts` — 1 missing .ok check (line 74)
- Add proper .ok checks before .json() calls

---

## WAVE 2: A11y (72 → 95+) — 4 agents

### Agent 2A: Icon-only button aria-labels (+7)
Grep ALL `<button` elements across .astro files. Check each has either:
- Visible text content, OR
- `aria-label="..."` attribute
Fix ALL icon-only buttons missing labels. Priority files:
- `src/pages/live.astro` — player controls, reactions, chat buttons
- `src/pages/dj-mix/[id].astro` — play, download, share, like buttons
- `src/pages/account/dj-lobby.astro` — stream controls, schedule buttons
- `src/components/Header.astro` — mobile menu, cart, account buttons
- `src/components/GlobalAudioPlayer.astro` — play/pause, next, prev, shuffle
- All admin pages — edit, delete, toggle buttons
- Estimate: ~7-10 buttons need labels

### Agent 2B: Color contrast fixes (+5)
Grep for `text-gray-400` and `text-gray-500` on dark backgrounds (bg-gray-800/900/950/black):
- Replace with `text-gray-300` (minimum 4.5:1 contrast ratio)
- Check: footer, player, sidebar, admin panels, form hints
- Also check `text-zinc-400`, `text-neutral-400`, `text-slate-400` variants
- Verify fixes don't break light-mode readability

### Agent 2C: Keyboard navigation — modal focus traps (+4)
Audit ALL modals/dialogs for:
- Focus trap on open (Tab cycles within modal)
- Escape key closes modal
- Focus returns to trigger on close
Priority:
- Merch size/color selector modal
- Image lightbox modals
- Playlist add/edit modals
- Share modals
- Any modal without `role="dialog"` + `aria-modal="true"`

### Agent 2D: aria-live regions + autocomplete attrs (+5)
1. Add aria-live="polite" to ALL dynamic content areas:
   - Cart count badge updates
   - Search results container
   - Upload progress indicators
   - Form validation error summaries
   - Notification/toast container (verify existing)
2. Add autocomplete attributes to:
   - Checkout address fields (name, email, address-line1, postal-code, country)
   - Login email/password (email, current-password)
   - Register fields (name, email, new-password)
   - Contact form (name, email)

---

## WAVE 3: Security (71 → 95+) — 3 agents

### Agent 3A: Auth coverage audit (+10)
Exhaustively audit ALL POST/PUT/DELETE API endpoints:
1. `grep -r "export.*POST\|export.*PUT\|export.*DELETE" src/pages/api/`
2. For EACH endpoint, verify one of:
   - `verifyRequestUser` or `requireAdminAuth` (authenticated)
   - Stripe/PayPal signature verification (webhook)
   - CRON_SECRET Bearer token (cron)
   - Intentionally public (health, consent-log)
3. Create a spreadsheet-style output: endpoint | auth method | status
4. Fix ANY endpoint that should require auth but doesn't
5. Specifically check: track-mix-play, track-mix-like, track-mix-download, cart operations

### Agent 3B: CORS tightening + cookie audit (+7)
1. CORS: Replace `*.freshwax.pages.dev` wildcard with explicit preview URL list OR add a comment documenting the security trade-off and why it's acceptable
2. Cookie audit: Grep ALL `Set-Cookie`, `document.cookie`, `cookie =` across entire codebase
   - Every cookie must have: Secure (in prod), HttpOnly (if not client-read), SameSite
   - Document each cookie: name, purpose, flags
3. Add `__Host-` prefix to session cookies if possible (binds to domain + Secure + Path=/)

### Agent 3C: CSP tightening (ignore Astro limitation) (+8)
Per user instruction to ignore Astro limitations:
1. Add nonce to CSP script-src: `'nonce-{random}'` replacing `'unsafe-inline'`
2. In middleware.ts, generate a random nonce per request
3. Pass nonce via Astro.locals to Layout.astro
4. Add `nonce` attribute to ALL `<script>` tags in Layout.astro
5. For `<script is:inline>` tags that Astro inlines — these get the nonce from the rendered HTML
6. Test with `npm run build` — if Astro doesn't support nonce on renderScript output, document the limitation but still implement for manually-written script tags
7. Remove `'unsafe-inline'` from script-src, add `'strict-dynamic'` if needed

---

## WAVE 4: Performance (72 → 95+) — 5 agents

### Agent 4A: CSS size reduction — dj-lobby.css + live.css (+6)
1. `src/pages/account/dj-lobby.css` (193KB) — audit for:
   - Dead CSS selectors not used in dj-lobby.astro
   - Duplicate @keyframes (43 animations — deduplicate)
   - Consolidate similar animations (19 pulse variants → 3-4)
   - Extract truly global animations to global.css
2. `src/pages/live.css` (172KB) — same audit
3. Verify these CSS files are page-scoped (not globally loaded)
4. Target: each file under 100KB

### Agent 4B: Image srcset + fetchpriority (+6)
1. Add srcset to ALL product/artwork images:
   - `src/pages/item/[id].astro` — hero artwork (400w, 800w, 1200w)
   - `src/pages/dj-mix/[id].astro` — mix artwork
   - `src/pages/merch/[id].astro` — product images
   - `src/pages/releases.astro` — grid thumbnails
   - `src/pages/dj-mixes.astro` — grid thumbnails
   - `src/pages/crates.astro` — vinyl images
2. Add `fetchpriority="high"` to hero/LCP images on:
   - Homepage hero
   - item/[id] main artwork
   - dj-mix/[id] main artwork
   - merch/[id] main product image
3. Add missing `width` and `height` attributes to ALL `<img>` tags

### Agent 4C: Interval leak fixes (+5)
1. `src/pages/forgot-password.astro` — countdown interval has NO cleanup on View Transitions. Add astro:before-swap listener to clearInterval.
2. Audit ALL setInterval in .astro files — verify each has cleanup:
   - Search: `setInterval` across all .astro files
   - Each must have matching `clearInterval` in `astro:before-swap` or `beforeunload`
3. Verify live.astro, dj-lobby.astro, dashboard.astro, admin/* intervals are cleaned up

### Agent 4D: Lazy loading heavy components (+5)
1. HLS.js — lazy load only when user clicks play:
   - In live-stream.js, wrap HLS.js import in an async function called on play
   - `const { default: Hls } = await import('https://cdn.jsdelivr.net/npm/hls.js@1/+esm')`
2. Pusher — lazy load only when needed:
   - Don't inject Pusher script at module scope
   - Load on first authenticated interaction
3. JSZip — verify it uses dynamic import() (may already be done)
4. content-visibility: auto on remaining admin tables:
   - admin/orders.astro, admin/streaming.astro, admin/vinyl/orders.astro, admin/releases/manage.astro

### Agent 4E: Sequential fetch → parallel (+4)
1. `src/pages/api/paypal/capture-order.ts` — parallelize idempotency check + stock validation (both independent reads)
2. Check other payment endpoints for sequential await chains that could be Promise.all
3. Check admin pages for sequential data loading that could be parallel

---

## WAVE 5: Code Quality (62 → 95+) — 5 agents

### Agent 5A: Split large client files — playlist-modal-init.ts (2013 lines) (+4)
Split into focused modules:
- `src/lib/playlist-modal/types.ts` — interfaces, type definitions
- `src/lib/playlist-modal/dom.ts` — DOM manipulation, rendering
- `src/lib/playlist-modal/api.ts` — fetch calls, data loading
- `src/lib/playlist-modal/events.ts` — event handlers
- `src/lib/playlist-modal/index.ts` — barrel re-export
Keep playlist-modal-init.ts as thin orchestrator (<300 lines)

### Agent 5B: Split large client files — checkout-client.ts (1586 lines) + release-plate-client.ts (1450 lines) (+4)
checkout-client.ts:
- `src/lib/checkout/stripe.ts` — Stripe-specific logic
- `src/lib/checkout/paypal.ts` — PayPal-specific logic
- `src/lib/checkout/validation.ts` — price/stock validation
- `src/lib/checkout/ui.ts` — DOM updates, form handling
release-plate-client.ts:
- `src/lib/release-plate/cache.ts` — caching logic
- `src/lib/release-plate/api.ts` — API calls
- `src/lib/release-plate/player.ts` — audio playback
- `src/lib/release-plate/ui.ts` — DOM rendering

### Agent 5C: Split remaining large server files (+4)
Files >500 lines that can be split:
- `src/lib/order/seller-payments.ts` (739 lines) — split artist/merch/vinyl into separate files
- `src/lib/order/create-order-emails.ts` (503 lines) — one file per email template
- `src/lib/types.ts` (715 lines) — split by domain (order types, user types, product types)
- `src/pages/api/paypal/capture-order.ts` (675 lines) — extract validation + ledger recording

### Agent 5D: Add Zod to remaining POST endpoints (+5)
Find ALL POST endpoints without Zod validation:
- `grep -l "export.*POST" src/pages/api/**/*.ts | xargs grep -L "z\." `
- Add Zod schemas to each (minimum: validate required fields, type check)
- Priority: icecast-auth, icecast-status, playlist/history, playlist/personal, playlist/skip
- Also check: any endpoint parsing `request.json()` without validation

### Agent 5E: Extract magic constants + cleanup (+5)
1. Create `src/lib/timeouts.ts`:
   ```
   export const TIMEOUTS = { API: 10000, LONG: 30000, SHORT: 5000 } as const;
   ```
   Replace ALL hardcoded timeout values (20+ locations)
2. Remove the 3 remaining `as any` in production code (not tests)
3. Replace 2 `: object` types with proper interfaces
4. Verify 0 dead code / commented-out blocks remain

---

## WAVE 6: SEO (83 → 95+) — 2 agents

### Agent 6A: Meta descriptions + structured data (+7)
1. Expand short meta descriptions:
   - `login.astro` — expand to 100+ chars
   - `404.astro` — expand to 100+ chars
2. Add FAQ schema to `crates.astro` — pass faqs array to SEO component
3. Add `hreflang="en-US"` to SEO.astro (site ships internationally)
4. Check ALL remaining pages for meta description length (50-160 chars)

### Agent 6B: CLS prevention + page speed signals (+5)
1. `index.astro` hero video — add poster image and explicit dimensions to prevent CLS
2. Review all `content-visibility: auto` usage for CLS side effects
3. Verify ALL images have explicit width/height (overlaps with Wave 4 Agent 4B)
4. Check font loading doesn't cause layout shifts

---

## WAVE 7: Infrastructure (87 → 95+) — 2 agents

### Agent 7A: Raise coverage thresholds + fix npm audit (+8)
1. Raise vitest coverage thresholds:
   - Lines: 5% → 30% (realistic for current test count)
   - Add functions: 25%, branches: 20%
2. Fix npm audit HIGH vulnerabilities:
   - Update fast-xml-parser, h3, svgo via overrides or direct updates
   - Run `npm audit --omit=dev --audit-level=high` — must pass
3. Add Lighthouse CI step to deploy.yml (run against local build)

### Agent 7B: Coverage threshold + staging docs (+5)
1. Run `npx vitest run --coverage` to get actual coverage numbers
2. Set thresholds to 80% of current actual (prevent regressions without breaking CI)
3. Add staging deployment documentation to README
4. Add `npm run test:coverage` to validate script in package.json

---

## Execution Order

**Phase 1 (Waves 1-2): Errors + A11y** — 8 agents in parallel
Biggest gaps, most user-facing impact.

**Phase 2 (Waves 3-4): Security + Performance** — 8 agents in parallel
Security hardening and load time improvements.

**Phase 3 (Waves 5-6): Code Quality + SEO** — 7 agents in parallel
Refactoring and search optimization.

**Phase 4 (Wave 7): Infrastructure** — 2 agents in parallel
CI/CD improvements.

## Verification After Each Phase
- `npm run build` — zero errors
- `npx vitest run` — all tests pass
- Git commit per phase

## Total: 25 agents across 7 waves in 4 phases
