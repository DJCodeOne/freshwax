// types.ts - TypeScript interfaces for mix processor

export interface Env {
  // R2 Bucket
  MIXES_BUCKET: R2Bucket;

  // Environment variables
  R2_PUBLIC_DOMAIN: string;

  // Secrets
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  RESEND_API_KEY: string;
  ADMIN_EMAIL: string;
}

export interface MixSubmissionMetadata {
  // DJ Info
  djName: string;
  displayName?: string;
  email: string;
  userId?: string;

  // Mix Details
  title: string;
  mixTitle?: string;
  genre?: string;
  description?: string;
  shoutOuts?: string;

  // Tracklist
  tracklist?: string;
  tracklistArray?: string[];

  // Duration (from audio file)
  duration?: string;
  durationSeconds?: number;

  // Settings
  allowDownload?: boolean;
  published?: boolean;

  // Metadata
  submittedAt: string;
  uploadedAt?: string;
}

export interface ProcessedMix {
  id: string;
  title: string;
  name: string;
  mixTitle: string;
  djName: string;
  dj_name: string;
  displayName: string;
  userId?: string;
  email?: string;

  // URLs
  audioUrl: string;
  audio_url: string;
  mp3Url: string;
  artworkUrl: string;
  artwork_url: string;
  imageUrl: string;

  // Details
  genre?: string;
  description?: string;
  shoutOuts?: string;
  tracklist?: string;
  tracklistArray?: string[];
  trackCount: number;

  // Duration
  duration?: string;
  durationSeconds?: number;
  durationFormatted?: string;
  durationMs?: number;

  // Stats (initialized to 0)
  plays: number;
  playCount: number;
  likes: number;
  likeCount: number;
  downloads: number;
  downloadCount: number;
  commentCount: number;

  // Ratings
  ratings: {
    count: number;
    total: number;
    average: number;
  };

  // Settings
  allowDownload: boolean;
  published: boolean;
  featured: boolean;
  approved: boolean;

  // Status
  status: 'live' | 'draft' | 'pending';
  storage: 'r2';

  // Timestamps
  createdAt: string;
  uploadedAt: string;
  updatedAt: string;
  upload_date: string;

  // R2 metadata
  folder_path: string;
  r2FolderName: string;
}

export interface ProcessingResult {
  success: boolean;
  mixId?: string;
  error?: string;
}
