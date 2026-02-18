// image-processor.ts - Image conversion using @cf-wasm/photon
// Based on existing src/lib/image-processing.ts
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
 * Process artwork: creates 800x800 cover + 400x400 thumbnail
 */
export async function processArtwork(
  submissionId: string,
  artworkKey: string,
  releaseId: string,
  env: Env
): Promise<{ coverUrl: string; thumbUrl: string }> {
  console.log(`[Image] Processing artwork: ${artworkKey}`);

  // Download artwork from releases bucket (submissions/ folder)
  const artworkObj = await env.RELEASES_BUCKET.get(artworkKey);
  if (!artworkObj) {
    throw new Error(`Artwork not found: ${artworkKey}`);
  }

  const artworkBuffer = await artworkObj.arrayBuffer();
  console.log(`[Image] Downloaded artwork: ${artworkBuffer.byteLength} bytes`);

  // Process cover (800x800)
  const cover = await processImageToSquareWebP(artworkBuffer, 800);
  console.log(`[Image] Created cover: ${cover.buffer.byteLength} bytes (${cover.format})`);

  // Process thumbnail (400x400)
  const thumb = await processImageToSquareWebP(artworkBuffer, 400);
  console.log(`[Image] Created thumbnail: ${thumb.buffer.byteLength} bytes (${thumb.format})`);

  // Upload to releases bucket with dynamic extensions based on chosen format
  const coverExt = imageExtension(cover.format);
  const thumbExt = imageExtension(thumb.format);
  const coverKey = `releases/${releaseId}/artwork/cover${coverExt}`;
  const thumbKey = `releases/${releaseId}/artwork/thumb${thumbExt}`;

  await Promise.all([
    env.RELEASES_BUCKET.put(coverKey, cover.buffer, {
      httpMetadata: {
        contentType: imageContentType(cover.format),
        cacheControl: 'public, max-age=31536000, immutable'
      }
    }),
    env.RELEASES_BUCKET.put(thumbKey, thumb.buffer, {
      httpMetadata: {
        contentType: imageContentType(thumb.format),
        cacheControl: 'public, max-age=31536000, immutable'
      }
    })
  ]);

  const coverUrl = `${env.R2_PUBLIC_DOMAIN}/${coverKey}`;
  const thumbUrl = `${env.R2_PUBLIC_DOMAIN}/${thumbKey}`;

  console.log(`[Image] Uploaded cover: ${coverUrl}`);
  console.log(`[Image] Uploaded thumbnail: ${thumbUrl}`);

  return { coverUrl, thumbUrl };
}
