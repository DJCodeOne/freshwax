# Contributing to Freshwax

## Code Style

- **TypeScript** for all server-side code (`src/pages/api/`, `src/lib/`).
- **No TypeScript in inline scripts**: `<script is:inline>` and `<script define:vars>` blocks are not processed by Vite. Use plain JavaScript only.
- **Vanilla JS**: No client-side frameworks (React, Vue, etc.). Use Astro components and `<script>` tags.
- **Tailwind CSS**: Use utility classes. When extracting to a CSS file, add `@reference "tailwindcss";` at the top.

## Conventions

- Use `createLogger` from `src/lib/api-utils.ts` instead of `console.log` in API endpoints.
- Use `successResponse` / `ApiErrors` from `src/lib/api-utils.ts` for API responses.
- Use `fetchWithTimeout` from `src/lib/fetch-timeout.ts` for all external HTTP calls.
- Catch blocks must type the error as `unknown` (`catch (e: unknown)`).
- Avoid `any` -- use `Record<string, unknown>` or specific types.

## Environment Variables

- Secrets go in the Cloudflare dashboard, never in `wrangler.toml`.
- Public values (safe for client-side) use the `PUBLIC_` prefix and go in `wrangler.toml [vars]`.
- Keep `.env.example` and `src/env.d.ts` in sync when adding or removing variables.

## Testing

- Unit tests: `npm run test` (Vitest, files in `src/__tests__/`).
- E2E tests: `npx playwright test` (Playwright, files in `e2e/`).
- Always run `npm run build` before pushing -- it must complete with zero errors.

## D1 Migrations

- Add numbered SQL files to `database/migrations/` (e.g. `0010_add_table.sql`).
- Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for safety.
- Apply with `npx wrangler d1 migrations apply freshwax-db --remote`.

## Commits

- Keep commits focused on a single concern.
- Run `npm run validate` (lint + typecheck + test + build) before committing.

## Important Warnings

- Do **not** change `compatibility_date` in `wrangler.toml` beyond `2025-02-13`.
- Do **not** remove `@xmldom/xmldom` -- it polyfills `DOMParser` for `@aws-sdk` in Workers.
- Do **not** add TypeScript syntax to `<script is:inline>` or `<script define:vars>` blocks.
