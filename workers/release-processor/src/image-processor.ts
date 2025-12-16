// image-processor.ts - WebP conversion using @cf-wasm/photon
// Based on existing src/lib/image-processing.ts

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon';
import type { Env } from './types';

export interface ProcessedImage {
  buffer: Uint8Array;
  width: number;
  height: number;
  format: string;
}

/**
 * Resize and crop image to a square, then convert to WebP
 */
export async function processImageToSquareWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  targetSize: number
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

  // Convert to WebP
  const webpBuffer = resized.get_bytes_webp();
  resized.free();

  return {
    buffer: webpBuffer,
    width: targetSize,
    height: targetSize,
    format: 'webp'
  };
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
  console.log(`[Image] Created cover: ${cover.buffer.byteLength} bytes`);

  // Process thumbnail (400x400)
  const thumb = await processImageToSquareWebP(artworkBuffer, 400);
  console.log(`[Image] Created thumbnail: ${thumb.buffer.byteLength} bytes`);

  // Upload to releases bucket
  const coverKey = `releases/${releaseId}/artwork/cover.webp`;
  const thumbKey = `releases/${releaseId}/artwork/thumb.webp`;

  await Promise.all([
    env.RELEASES_BUCKET.put(coverKey, cover.buffer, {
      httpMetadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000'
      }
    }),
    env.RELEASES_BUCKET.put(thumbKey, thumb.buffer, {
      httpMetadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000'
      }
    })
  ]);

  const coverUrl = `${env.R2_PUBLIC_DOMAIN}/${coverKey}`;
  const thumbUrl = `${env.R2_PUBLIC_DOMAIN}/${thumbKey}`;

  console.log(`[Image] Uploaded cover: ${coverUrl}`);
  console.log(`[Image] Uploaded thumbnail: ${thumbUrl}`);

  return { coverUrl, thumbUrl };
}
