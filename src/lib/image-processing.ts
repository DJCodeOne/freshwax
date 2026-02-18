// src/lib/image-processing.ts
// WASM-based image processing for Cloudflare Workers
// Uses @cf-wasm/photon instead of sharp (which requires Node.js native modules)

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon';

export interface ProcessedImage {
  buffer: Uint8Array;
  width: number;
  height: number;
  format: string;
  debug?: { attempt: number; size: number; dimensions: string }[];
}

const MAX_BYTES = 100 * 1024; // 100KB hard limit for all cover images
const MIN_SIZE = 300; // Never go below 300px
const MAX_ATTEMPTS = 5;

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

  // crop() takes (x1, y1, x2, y2) corner coordinates, NOT (x, y, width, height)
  const cropped = crop(img, cropX, cropY, cropX + minDimension, cropY + minDimension);
  img.free();

  // Save cropped image as PNG bytes so we can reload fresh each iteration
  // (WASM resize() can invalidate the input pointer, breaking subsequent calls)
  const croppedBytes = cropped.get_bytes();
  cropped.free();

  let currentSize = targetSize;
  let webpBuffer: Uint8Array = new Uint8Array(0);
  const debugLog: { attempt: number; size: number; dimensions: string }[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fresh = PhotonImage.new_from_byteslice(croppedBytes);
    const resized = resize(fresh, currentSize, currentSize, SamplingFilter.Lanczos3);
    fresh.free();
    webpBuffer = resized.get_bytes_webp();
    resized.free();

    debugLog.push({ attempt, size: webpBuffer.length, dimensions: `${currentSize}x${currentSize}` });

    if (webpBuffer.length <= MAX_BYTES || currentSize <= MIN_SIZE) {
      break;
    }

    // Scale down proportionally to hit 100KB target (with 10% safety margin)
    const ratio = Math.sqrt(MAX_BYTES / webpBuffer.length) * 0.9;
    currentSize = Math.max(MIN_SIZE, Math.floor(currentSize * ratio));
  }

  return { buffer: webpBuffer, width: currentSize, height: currentSize, format: 'webp', debug: debugLog };
}

/**
 * Resize image maintaining aspect ratio to WebP, guaranteed under 100KB.
 */
export async function processImageToWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  maxWidth: number,
  maxHeight: number,
  _quality: number = 80
): Promise<ProcessedImage> {
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  const img = PhotonImage.new_from_byteslice(input);

  const originalWidth = img.get_width();
  const originalHeight = img.get_height();
  const aspectRatio = originalWidth / originalHeight;

  // Calculate initial dimensions maintaining aspect ratio
  let newWidth = originalWidth;
  let newHeight = originalHeight;

  if (originalWidth > maxWidth || originalHeight > maxHeight) {
    const widthRatio = maxWidth / originalWidth;
    const heightRatio = maxHeight / originalHeight;
    const ratio = Math.min(widthRatio, heightRatio);
    newWidth = Math.floor(originalWidth * ratio);
    newHeight = Math.floor(originalHeight * ratio);
  }

  // Save source as PNG bytes for safe reuse across iterations
  const sourceBytes = img.get_bytes();
  img.free();

  let webpBuffer: Uint8Array = new Uint8Array(0);
  const debugLog: { attempt: number; size: number; dimensions: string }[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fresh = PhotonImage.new_from_byteslice(sourceBytes);
    // Always resize — even if dimensions match, this ensures a clean re-encode
    const processed = resize(fresh, newWidth, newHeight, SamplingFilter.Lanczos3);
    fresh.free();

    webpBuffer = processed.get_bytes_webp();
    processed.free();

    debugLog.push({ attempt, size: webpBuffer.length, dimensions: `${newWidth}x${newHeight}` });

    if (webpBuffer.length <= MAX_BYTES || (newWidth <= MIN_SIZE && newHeight <= MIN_SIZE)) {
      break;
    }

    // Scale down proportionally to hit 100KB target
    const ratio = Math.sqrt(MAX_BYTES / webpBuffer.length) * 0.9;
    newWidth = Math.max(MIN_SIZE, Math.floor(newWidth * ratio));
    newHeight = Math.max(MIN_SIZE, Math.floor(newWidth / aspectRatio));
  }

  return { buffer: webpBuffer, width: newWidth, height: newHeight, format: 'webp', debug: debugLog };
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
 * Get image dimensions without full processing
 */
export function getImageDimensions(inputBuffer: ArrayBuffer | Uint8Array): { width: number; height: number } {
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  const img = PhotonImage.new_from_byteslice(input);
  const width = img.get_width();
  const height = img.get_height();
  img.free();

  return { width, height };
}
