/**
 * Verify that the __session cookie's JWT payload matches the expected userId.
 * This is a lightweight check (no cryptographic verification) to prevent
 * IDOR via forged userId/partnerId/customerId cookies in SSR pre-fetches.
 * Full auth verification happens client-side via Firebase Auth.
 *
 * Returns the verified userId if the session JWT's user_id/sub claim matches
 * the expected cookie value. Returns null if verification fails or cookies
 * are missing, which causes the SSR pre-fetch to be skipped.
 */
export function verifySessionMatch(cookies: {
  session?: string;
  userId?: string;
  partnerId?: string;
  customerId?: string;
}): string | null {
  const { session, userId, partnerId, customerId } = cookies;
  const expectedId = partnerId || userId || customerId;
  if (!session || !expectedId) return null;

  try {
    // JWT format: header.payload.signature
    const parts = session.split('.');
    if (parts.length !== 3) return null;

    // Decode the payload (base64url -> base64 -> string)
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(payload);
    const claims = JSON.parse(decoded);

    // Firebase ID tokens use 'user_id' claim (also available as 'sub')
    const tokenUserId = claims.user_id || claims.sub;
    if (!tokenUserId) return null;

    // Verify the cookie userId matches the JWT userId
    if (tokenUserId !== expectedId) return null;

    return tokenUserId;
  } catch {
    return null;
  }
}
