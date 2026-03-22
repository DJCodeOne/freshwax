// src/lib/firebase-service-account.ts
// Barrel re-export — split into focused modules in firebase-sa/
// All 72+ consumers import from this file and continue to work unchanged.

export { getServiceAccountKey, getServiceAccountKeyWithProject, getServiceAccountToken } from './firebase-sa/auth';
export { toFirestoreValue, fromFirestoreValue } from './firebase-sa/serialization';
export { saGetDocument, saSetDocument, saUpdateDocument, saDeleteDocument, saAddDocument, saQueryCollection } from './firebase-sa/crud';
