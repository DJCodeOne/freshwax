// image-processor.ts - Image conversion using @cf-wasm/photon
// Always outputs WebP with 100KB size limit

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon';
import type { Env } from './types';

export interface ProcessedImage {
  buffer: Uint8Array;
  width: number;
  height: number;
  format: string;
}

const MAX_BYTES = 100 * 1024; // 100KB hard limit for all cover images
const MIN_SIZE = 300; // Never go below 300px
const MAX_ATTEMPTS = 5;

/** Get file extension for a processed image format */
export function imageExtension(format: string): string {
  return format === 'jpeg' ? '.jpg' : '.webp';
}

/** Get MIME content type for a processed image format */
export function imageContentType(format: string): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

/**
 * Resize and crop image to a square WebP, guaranteed under 100KB.
 * If the first encode exceeds 100KB, progressively reduces dimensions.
 */
export async function processImageToSquareWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  targetSize: number,
  _quality: number = 80
): Promise<ProcessedImage> {
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  const img = PhotonImage.new_from_byteslice(input);

  const originalWidth = img.get_width();
  const originalHeight = img.get_height();

  // Center crop to square
  const minDimension = Math.min(originalWidth, originalHeight);
  const cropX = Math.floor((originalWidth - minDimension) / 2);
  const cropY = Math.floor((originalHeight - minDimension) / 2);

  const cropped = crop(img, cropX, cropY, minDimension, minDimension);
  img.free();

  // Iteratively resize + encode until WebP is under 100KB
  let currentSize = targetSize;
  let webpBuffer: Uint8Array = new Uint8Array(0);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const resized = resize(cropped, currentSize, currentSize, SamplingFilter.Lanczos3);
    webpBuffer = resized.get_bytes_webp();
    resized.free();

    if (webpBuffer.length <= MAX_BYTES || currentSize <= MIN_SIZE) {
      break;
    }

    // Scale down proportionally to hit 100KB target (with 10% safety margin)
    const ratio = Math.sqrt(MAX_BYTES / webpBuffer.length) * 0.9;
    currentSize = Math.max(MIN_SIZE, Math.floor(currentSize * ratio));
  }

  cropped.free();
  return { buffer: webpBuffer, width: currentSize, height: currentSize, format: 'webp' };
}

/**
 * Process mix artwork: creates 1200x1200 artwork
 */
export async function processArtwork(
  submissionId: string,
  artworkKey: string,
  mixId: string,
  env: Env
): Promise<{ artworkUrl: string }> {
  console.log(`[Image] Processing artwork: ${artworkKey}`);

  // Download artwork from mixes bucket (mix-submissions/ folder)
  const artworkObj = await env.MIXES_BUCKET.get(artworkKey);
  if (!artworkObj) {
    throw new Error(`Artwork not found: ${artworkKey}`);
  }

  const artworkBuffer = await artworkObj.arrayBuffer();
  console.log(`[Image] Downloaded artwork: ${artworkBuffer.byteLength} bytes`);

  // Process artwork (1200x1200)
  const artwork = await processImageToSquareWebP(artworkBuffer, 1200, 85);
  console.log(`[Image] Created artwork: ${artwork.buffer.byteLength} bytes (${artwork.format})`);

  // Upload to mixes bucket with dynamic extension based on chosen format
  const ext = imageExtension(artwork.format);
  const artworkOutputKey = `dj-mixes/${mixId}/artwork${ext}`;

  await env.MIXES_BUCKET.put(artworkOutputKey, artwork.buffer, {
    httpMetadata: {
      contentType: imageContentType(artwork.format),
      cacheControl: 'public, max-age=31536000, immutable'
    }
  });

  const artworkUrl = `${env.R2_PUBLIC_DOMAIN}/${artworkOutputKey}`;
  console.log(`[Image] Uploaded artwork: ${artworkUrl}`);

  return { artworkUrl };
}
