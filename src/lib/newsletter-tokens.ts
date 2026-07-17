// src/lib/newsletter-tokens.ts
// Signed unsubscribe links for marketing email.
//
// Every marketing send carries a per-recipient HMAC token so the recipient can
// unsubscribe from the email itself — no login, no re-typing their address.
// Mirrors the review-token pattern in lib/reviews.ts, with an `unsub:` prefix
// so a token minted for one purpose can never be replayed against the other.
//
// The token is deliberately deterministic and non-expiring: unsubscribe links
// must keep working in a mailbox years later. It authenticates "this link came
// from an email we sent to this address", not a session.

/** Same address normalisation as newsletter/subscribe.ts — tokens must agree. */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function tokenSecret(env: Record<string, unknown> | undefined): string {
  return String(
    env?.NEWSLETTER_TOKEN_SECRET || env?.CRON_SECRET ||
    import.meta.env.NEWSLETTER_TOKEN_SECRET || import.meta.env.CRON_SECRET || ''
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Signed token authorising unsubscribe for a single address. */
export async function unsubscribeToken(
  env: Record<string, unknown> | undefined,
  email: string
): Promise<string> {
  const secret = tokenSecret(env);
  if (!secret) throw new Error('Newsletter token secret not configured');
  return (await hmacHex(secret, `unsub:${normalizeEmail(email)}`)).slice(0, 32);
}

export async function verifyUnsubscribeToken(
  env: Record<string, unknown> | undefined,
  email: string,
  token: string
): Promise<boolean> {
  try {
    const expected = await unsubscribeToken(env, email);
    if (!token || token.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

/**
 * Per-recipient unsubscribe URLs for a marketing send.
 *
 * `oneClick` is the RFC 8058 List-Unsubscribe-Post target: POST-only, so that
 * mailbox link-scanners (which issue GETs) can't silently unsubscribe people.
 * `page` is the human-facing link for the email footer — it lands on a confirm
 * button rather than acting on the GET, for the same reason.
 */
export async function unsubscribeUrls(
  env: Record<string, unknown> | undefined,
  siteUrl: string,
  email: string
): Promise<{ oneClick: string; page: string }> {
  const e = normalizeEmail(email);
  const t = await unsubscribeToken(env, e);
  const qs = `e=${encodeURIComponent(e)}&t=${t}`;
  return {
    oneClick: `${siteUrl}/api/newsletter/one-click/?${qs}`,
    page: `${siteUrl}/unsubscribe/?${qs}`,
  };
}
