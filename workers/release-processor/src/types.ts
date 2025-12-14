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
  bpm?: number;
  key?: string;
  genre?: string;
  duration?: number;
}

export interface SubmissionMetadata {
  artistName: string;
  releaseName: string;
  genre?: string;
  catalogNumber?: string;
  releaseDate?: string;
  description?: string;
  pricePerSale?: number;
  trackPrice?: number;
  vinylPrice?: number;
  vinylRelease?: boolean;
  tracks: TrackMetadata[];
  submittedAt: string;
  email: string;
}

export interface ProcessedTrack {
  trackNumber: number;
  title: string;
  mp3Url: string;
  wavUrl: string;
  previewUrl: string;
  duration?: number;
  bpm?: number;
  key?: string;
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
  genre?: string;
  catalogNumber?: string;
  releaseDate?: string;
  description?: string;
  pricePerSale?: number;
  trackPrice?: number;
  vinylPrice?: number;
  vinylRelease?: boolean;
  status: 'pending';
  published: false;
  approved: false;
  storage: 'r2';
  createdAt: string;
  updatedAt: string;
  processedAt: string;
}

export interface ProcessingResult {
  success: boolean;
  releaseId?: string;
  error?: string;
  processedTracks?: number;
}
