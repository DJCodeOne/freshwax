// src/lib/d1-catalog.ts
// Barrel re-export — all imports from '../lib/d1-catalog' continue to work unchanged

export type { FirestoreDoc, D1Database, D1PreparedStatement, D1Row } from './d1/types';
export type { D1Release } from './d1/releases';
export { releaseToD1Row, d1RowToRelease, d1GetAllPublishedReleases, d1SearchPublishedReleases, d1GetReleaseById, d1GetReleasesByArtist, d1UpsertRelease } from './d1/releases';
export type { D1DjMix } from './d1/mixes';
export { mixToD1Row, d1RowToMix, d1SearchPublishedMixes, d1GetAllPublishedMixes, d1GetAllMixes, d1GetMixById, d1GetMixesByUser, d1UpsertMix, d1DeleteMix } from './d1/mixes';
export type { D1Merch } from './d1/merch';
export { merchToD1Row, d1RowToMerch, d1SearchPublishedMerch, d1GetAllPublishedMerch, d1GetMerchById, d1UpsertMerch, d1DeleteMerch, d1GetMerchBySupplierId, d1GetMerchBySupplierName } from './d1/merch';
export type { D1Comment } from './d1/comments';
export { d1GetComments, d1AddComment, d1GetCommentCount } from './d1/comments';
export type { D1Rating } from './d1/ratings';
export { d1GetRatings, d1GetUserRating, d1UpsertRating } from './d1/ratings';
export type { D1LivestreamSlot } from './d1/slots';
export { slotToD1Row, d1RowToSlot, d1GetLiveSlots, d1GetScheduledSlots, d1GetSlotById, d1GetSlotsByDj, d1UpsertSlot, d1UpdateSlotStatus, d1DeleteSlot } from './d1/slots';
export type { D1LedgerEntry } from './d1/ledger';
export { ledgerToD1Row, d1RowToLedger, d1InsertLedgerEntry, d1UpdateLedgerEntry, d1GetLedgerEntries, d1GetLedgerEntryById, d1GetLedgerEntriesByOrder, d1GetLedgerEntriesByArtist, d1GetLedgerTotals, d1DeleteLedgerEntry } from './d1/ledger';
export type { D1VinylSeller } from './d1/vinyl-sellers';
export { vinylSellerToD1Row, d1RowToVinylSeller, d1GetVinylSeller, d1UpsertVinylSeller, d1GetAllVinylSellers, d1GetNextCollectionNumber, d1GetVinylSellerByCollection, d1GetAllCollections } from './d1/vinyl-sellers';
export type { RoyaltyEntry } from './d1/royalties';
export { d1RecordRoyalty, d1GetRoyaltyLedger, d1MarkRoyaltiesPaid } from './d1/royalties';
