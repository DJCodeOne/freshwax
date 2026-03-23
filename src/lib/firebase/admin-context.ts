// src/lib/firebase/admin-context.ts
// Shared helper to extract Firebase admin context from Astro locals.
// Eliminates the repeated 4-5 line boilerplate across ~30 admin endpoints.

import { getServiceAccountKey, getServiceAccountToken } from '../firebase-service-account';
import { ApiErrors } from '../api-utils';

export interface AdminFirebaseContext {
  env: App.Locals['runtime']['env'];
  projectId: string;
  saKey: string;
  /** Lazily-resolved service account OAuth2 token (cached in firebase-sa/auth.ts) */
  getToken: () => Promise<string>;
}

/**
 * Extract Firebase admin context from Astro locals.
 * Returns either a valid context object or a pre-built error Response.
 *
 * Usage:
 * ```ts
 * const fbCtx = getAdminFirebaseContext(locals);
 * if (fbCtx instanceof Response) return fbCtx;
 * const { env, projectId, saKey } = fbCtx;
 * ```
 */
export function getAdminFirebaseContext(
  locals: App.Locals
): AdminFirebaseContext | Response {
  const env = locals.runtime.env;
  const projectId = (
    env?.FIREBASE_PROJECT_ID ||
    import.meta.env.FIREBASE_PROJECT_ID ||
    'freshwax-store'
  ) as string;

  const saKey = getServiceAccountKey(env);
  if (!saKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  return {
    env,
    projectId,
    saKey,
    getToken: () => getServiceAccountToken(saKey),
  };
}
