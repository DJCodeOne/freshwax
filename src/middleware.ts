// src/middleware.ts
// Initialize Firebase env from Cloudflare runtime on every request
import { defineMiddleware } from 'astro:middleware';
import { initFirebaseEnv } from './lib/firebase-rest';

export const onRequest = defineMiddleware(async ({ locals }, next) => {
  // Get Cloudflare runtime env and initialize Firebase
  const runtime = (locals as any).runtime;
  if (runtime?.env) {
    initFirebaseEnv(runtime.env);
  }

  return next();
});
