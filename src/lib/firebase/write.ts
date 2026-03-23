// src/lib/firebase/write.ts
// Barrel re-export — split into focused modules: mutations.ts and transforms.ts
// All existing imports from './firebase/write' continue to work unchanged.

export { setDocument, createDocumentIfNotExists, updateDocument, deleteDocument, addDocument } from './mutations';
export { atomicIncrement, updateDocumentConditional, arrayUnion, arrayRemove } from './transforms';
