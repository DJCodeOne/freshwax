// image-processor.ts - Image conversion using @cf-wasm/photon
// Generates both WebP and JPEG, returns whichever is smaller

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon';
import type { Env } from './types';

export interface ProcessedImage {
  buffer: Uint8Array;
  width: number;
  height: number;
  format: string;
}

/** Get file extension for a processed image format */
export function imageExtension(format: string): string {
  return format === 'jpeg' ? '.jpg' : '.webp';
}

/** Get MIME content type for a processed image format */
export function imageContentType(format: string): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

/**
 * Resize and crop image to a square, then convert to the smallest format
 */
export async function processImageToSquareWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  targetSize: number,
  quality: number = 80
): Promise<ProcessedImage> {
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  const img = PhotonImage.new_from_byteslice(input);

  const originalWidth = img.get_width();
  const originalHeight = img.get_height();

  // Calculate center crop to make it square
  const minDimension = Math.min(originalWidth, originalHeight);
  const cropX = Math.floor((originalWidth - minDimension) / 2);
  const cropY = Math.floor((originalHeight - minDimension) / 2);

  // Crop to square from center
  const cropped = crop(img, cropX, cropY, minDimension, minDimension);
  img.free();

  // Resize to target size
  const resized = resize(cropped, targetSize, targetSize, SamplingFilter.Lanczos3);
  cropped.free();

  // Generate both WebP and JPEG, keep the smaller one
  // (Photon's get_bytes_webp() has no quality param — can produce larger files than JPEG)
  const webpBuffer = resized.get_bytes_webp();
  const jpegBuffer = resized.get_bytes_jpeg(quality);
  resized.free();

  if (jpegBuffer.length < webpBuffer.length) {
    return { buffer: jpegBuffer, width: targetSize, height: targetSize, format: 'jpeg' };
  }
  return { buffer: webpBuffer, width: targetSize, height: targetSize, format: 'webp' };
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
