# Fresh Wax - Outstanding Updates & Recommendations

**Last Updated:** December 20, 2025

These are beneficial improvements that won't break existing functionality.

---

## Quick Wins (Low Effort, High Value)

### 1. Update npm Dependencies
```bash
npm audit fix
```
Fixes moderate vulnerability in `jws < 3.2.2` (improper signature verification).

### 2. Apply API Utilities to More Endpoints
The new `src/lib/api-utils.ts` utilities are ready. Gradually refactor other API endpoints to use:
- `createLogger()` - replaces console.log (auto-disabled in production)
- `successResponse()` / `errorResponse()` - standardized JSON responses
- `ApiErrors.badRequest()`, `.notFound()`, etc. - common error patterns

Priority endpoints to refactor:
- `src/pages/api/create-order.ts`
- `src/pages/api/livestream/*.ts`
- `src/pages/api/admin/*.ts`

### 3. Add Rate Limiting
High-risk public endpoints that could be spammed:
- `/api/newsletter/subscribe`
- `/api/contact`
- `/api/create-order`

Options:
- Cloudflare Rate Limiting (easiest, no code changes)
- Middleware-based limiting with KV storage

---

## Medium Priority

### 4. CSS Bundle Optimization
Large CSS files slowing page loads:
```
src/styles/dj-lobby.css - 133KB
src/styles/live.css - 119KB
src/styles/admin/index.css - 36KB
```

Actions:
- Remove unused CSS rules (PurgeCSS)
- Split into component-specific files
- Use CSS custom properties to reduce duplication

### 5. Use TypeScript Interfaces
The new `src/lib/types.ts` has interfaces for all Firebase documents. Gradually replace `any` types:
- Import `Release`, `Track`, `User`, `Order`, etc.
- Improves IDE autocomplete and catches bugs

### 6. API Authorization Audit
Only 11 of ~60 endpoints check Authorization headers. Review:
- `src/pages/api/admin/*.ts` - verify all have adminKey checks
- `src/pages/api/dj-lobby/*.ts` - verify auth requirements
- `src/pages/api/livestream/*.ts` - some may need protection

---

## Lower Priority

### 7. Add Testing
No test files currently. Recommended:
- API endpoint integration tests
- Firestore rules emulator tests
- E2E tests with Playwright for critical flows (checkout, booking)

### 8. Image Optimization
- Ensure all images use WebP format
- Add lazy loading to below-fold images
- Consider responsive images with srcset

### 9. Error Tracking
Consider adding Sentry or similar for production error monitoring.

### 10. Uptime Monitoring
Set up monitoring for:
- Main site availability
- API health (`/api/admin/health-check`)
- Livestream infrastructure

---

## Completed

- [x] Create `.env.example` with all environment variables
- [x] Create `src/lib/api-utils.ts` with logger and response helpers
- [x] Create `src/lib/types.ts` with TypeScript interfaces
- [x] Refactor `process-release.ts` to use new utilities

---

## Notes

- All recommendations are non-breaking improvements
- Prioritize Quick Wins for immediate value
- API utilities can be applied incrementally, one file at a time
- Test changes locally before deploying
