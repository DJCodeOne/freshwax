// src/lib/constants.ts
// Centralized site constants

/** Canonical production URL — used in emails, API redirects, and link generation */
export const SITE_URL = 'https://freshwax.co.uk';

/** Firebase Web API key — used in client-facing Firebase Auth REST calls.
 *  This is a public key (safe to include in client code). Runtime env vars
 *  don't resolve via import.meta.env in Cloudflare Workers, so hardcode it. */
export const FIREBASE_API_KEY = import.meta.env.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
