// src/lib/admin-query.ts
// Shared helper to build service account query function for admin endpoints.
// After Firestore rules lockdown, these collections require service account auth:
// users, artists, orders, bypassRequests, payouts, disputes, refunds, blog-posts, salesLedger

import { queryCollection } from './firebase-rest';
import { saQueryCollection } from './firebase-service-account';

export function getSaQuery(locals: App.Locals) {
  const env = locals?.runtime?.env || {};
  const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) return (c: string, o?: any) => queryCollection(c, o);
  const key = JSON.stringify({ type: 'service_account', project_id: projectId, private_key: privateKey.replace(/\\n/g, '\n'), client_email: clientEmail });
  return (c: string, o?: any) => saQueryCollection(key, projectId, c, o);
}
