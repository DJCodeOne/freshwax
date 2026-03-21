// src/lib/constants.ts
// Centralized site constants

/** Canonical production URL — used in emails, API redirects, and link generation */
export const SITE_URL = 'https://freshwax.co.uk';

/** Firebase Web API key — used in client-facing Firebase Auth REST calls.
 *  Must be set via PUBLIC_FIREBASE_API_KEY environment variable. */
export const FIREBASE_API_KEY = import.meta.env.PUBLIC_FIREBASE_API_KEY || '';
