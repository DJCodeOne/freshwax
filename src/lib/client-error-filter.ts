// src/lib/client-error-filter.ts
// Client error reports that are never actionable, dropped before they reach
// the D1 error log (/admin/errors).
//
// In Sep 2026, 34 of the 36 rows in the log came from crawler bots running
// pre-2020 JS engines (spoofed modern user agents from a handful of IPs): they
// can't parse the site's bundles at all, and they fail on Cloudflare's own
// beacon script too.
//
// The filter is deliberately narrow. A SyntaxError from a REAL browser is the
// signature of a genuine regression (e.g. TypeScript syntax leaking into an
// is:inline script breaks every page), so modern-engine SyntaxErrors must keep
// getting through.

// Old V8 (pre-2020) prints the offending token unquoted — "Unexpected token ."
// — while every current engine quotes it: "Unexpected token '.'" (Chrome,
// Safari) or "expected expression, got '.'" (Firefox).
const OLD_ENGINE_PARSE_ERROR = /SyntaxError: Unexpected token [^'"\s]/;

// Errors thrown inside third-party scripts are not ours to fix.
const THIRD_PARTY_SCRIPT = /^https?:\/\/(static\.cloudflareinsights\.com|www\.googletagmanager\.com|www\.google-analytics\.com)\//i;

export function isIgnorableClientError(message: string, url?: string | null): boolean {
  if (OLD_ENGINE_PARSE_ERROR.test(message)) return true;
  if (url && THIRD_PARTY_SCRIPT.test(url)) return true;
  return false;
}
