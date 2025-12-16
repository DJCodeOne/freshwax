// types.ts - TypeScript interfaces for release processor

export interface Env {
  // R2 Buckets
  UPLOADS_BUCKET: R2Bucket;
  RELEASES_BUCKET: R2Bucket;

  // Environment variables
  R2_PUBLIC_DOMAIN: string;

  // Secrets
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  RESEND_API_KEY: string;
  ADMIN_EMAIL: string;
}

export interface TrackMetadata {
  trackNumber: number;
  title: string;
  trackName?: string;
  bpm?: number;
  key?: string;
  genre?: string;
  duration?: number | string;
  trackISRC?: string;
  featured?: string;
  remixer?: string;
  explicit?: boolean;
}

export interface SocialLinks {
  instagram?: string;
  soundcloud?: string;
  spotify?: string;
  bandcamp?: string;
  youtube?: string;
  other?: string;
}

export interface VinylDetails {
  recordCount?: number | string;
  rpm?: string;
  size?: string;
  weight?: string;
  pressingPlant?: string;
  expectedShippingDate?: string;
}

export interface LimitedEdition {
  enabled?: boolean;
  type?: string;
  details?: string;
}

export interface SubmissionMetadata {
  // Artist Info
  artistName: string;
  email: string;
  userId?: string;

  // Release Details
  releaseName: string;
  releaseType?: string;
  labelCode?: string;
  masteredBy?: string;
  genre?: string;
  customGenre?: string;
  releaseDate?: string;
  catalogNumber?: string;
  description?: string;
  releaseDescription?: string;

  // Pre-order
  hasPreOrder?: boolean;
  preOrderDate?: string;

  // Content flags
  hasExplicitContent?: boolean;

  // Previous release info
  isPreviouslyReleased?: boolean;
  originalReleaseDate?: string;
  recordingLocation?: string;
  recordingYear?: string;

  // Copyright & Publishing
  copyrightYear?: string;
  copyrightHolder?: string;
  publishingRights?: string;
  publishingCompany?: string;
  primaryLanguage?: string;

  // Pricing
  pricePerSale?: number;
  trackPrice?: number;

  // Vinyl
  vinylRelease?: boolean;
  vinylPrice?: number;
  vinylRecordCount?: string;
  vinylRPM?: string;
  vinylSize?: string;
  vinylWeight?: string;
  pressingPlant?: string;
  expectedShippingDate?: string;
  vinyl?: VinylDetails;

  // Limited Edition
  hasLimitedEdition?: boolean;
  limitedEditionType?: string;
  limitedEditionDetails?: string;
  limitedEdition?: LimitedEdition;

  // Social Links
  instagramLink?: string;
  soundcloudLink?: string;
  spotifyLink?: string;
  bandcampLink?: string;
  youtubeLink?: string;
  otherLinks?: string;
  socialLinks?: SocialLinks;

  // Barcode
  upcEanCode?: string;

  // Notes
  notes?: string;

  // Tracks
  tracks: TrackMetadata[];
  trackListingJSON?: string;

  // Metadata
  submittedAt: string;
  uploadedAt?: string;
}

export interface ProcessedTrack {
  trackNumber: number;
  displayTrackNumber?: number;
  title: string;
  trackName?: string;
  mp3Url: string;
  wavUrl: string;
  previewUrl: string;
  duration?: number | string;
  bpm?: number;
  key?: string;
  trackISRC?: string;
  featured?: string;
  remixer?: string;
  explicit?: boolean;
}

export interface ProcessedRelease {
  id: string;
  artistName: string;
  releaseName: string;
  title: string;
  artist: string;
  coverUrl: string;
  thumbUrl: string;
  tracks: ProcessedTrack[];

  // Release Details
  releaseType?: string;
  labelCode?: string;
  masteredBy?: string;
  genre?: string;
  catalogNumber?: string;
  releaseDate?: string;
  description?: string;
  releaseDescription?: string;

  // Pre-order
  hasPreOrder?: boolean;
  preOrderDate?: string;

  // Content flags
  hasExplicitContent?: boolean;

  // Previous release info
  isPreviouslyReleased?: boolean;
  originalReleaseDate?: string;
  recordingLocation?: string;
  recordingYear?: string;

  // Copyright & Publishing
  copyrightYear?: string;
  copyrightHolder?: string;
  publishingRights?: string;
  publishingCompany?: string;
  primaryLanguage?: string;

  // Pricing
  pricePerSale?: number;
  trackPrice?: number;

  // Vinyl
  vinylRelease?: boolean;
  vinylPrice?: number;
  vinylRecordCount?: string;
  vinylRPM?: string;
  vinylSize?: string;
  vinylWeight?: string;
  pressingPlant?: string;
  expectedShippingDate?: string;

  // Limited Edition
  hasLimitedEdition?: boolean;
  limitedEditionType?: string;
  limitedEditionDetails?: string;

  // Social Links
  socialLinks?: SocialLinks;

  // Barcode
  upcEanCode?: string;

  // Notes
  notes?: string;

  // Status
  status: 'pending';
  published: false;
  approved: false;
  storage: 'r2';
  createdAt: string;
  updatedAt: string;
  processedAt: string;

  // Email for notifications
  email?: string;
  userId?: string;
}

export interface ProcessingResult {
  success: boolean;
  releaseId?: string;
  error?: string;
  processedTracks?: number;
}
