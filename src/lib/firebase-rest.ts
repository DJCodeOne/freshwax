// src/lib/firebase-rest.ts
// Barrel re-export — all 284 existing importers continue to work unchanged.
// Implementation split into focused modules under src/lib/firebase/

export { initFirebaseEnv, CACHE_TTL } from './firebase/core';
export type { QueryFilter, QueryOptions, FirestoreOp } from './firebase/core';
export { queryCollection, getDocument, getSettings, getDocumentsBatch, getLiveReleases, getLiveDJMixes, getLiveMerch, extractTracksFromReleases, shuffleArray } from './firebase/read';
export { setDocument, createDocumentIfNotExists, updateDocument, deleteDocument, atomicIncrement, updateDocumentConditional, arrayUnion, arrayRemove, addDocument } from './firebase/write';
export { clearCache, invalidateReleasesCache, invalidateMixesCache, clearAllMerchCache, invalidateUsersCache, getCacheStats } from './firebase/cache';
export { verifyUserToken, verifyRequestUser } from './firebase/verify';
