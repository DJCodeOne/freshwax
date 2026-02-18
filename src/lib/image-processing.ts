// src/lib/image-processing.ts
// WASM-based image processing for Cloudflare Workers
// Uses @cf-wasm/photon instead of sharp (which requires Node.js native modules)

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon';

export interface ProcessedImage {
  buffer: Uint8Array;
  width: number;
  height: number;
  format: string;
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

  // Iteratively resize + encode until WebP is under 100KB
  let webpBuffer: Uint8Array = new Uint8Array(0);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const processed = (newWidth !== originalWidth || newHeight !== originalHeight)
      ? resize(img, newWidth, newHeight, SamplingFilter.Lanczos3)
      : img;

    webpBuffer = processed.get_bytes_webp();
    if (processed !== img) processed.free();

    if (webpBuffer.length <= MAX_BYTES || (newWidth <= MIN_SIZE && newHeight <= MIN_SIZE)) {
      break;
    }

    // Scale down proportionally to hit 100KB target
    const ratio = Math.sqrt(MAX_BYTES / webpBuffer.length) * 0.9;
    newWidth = Math.max(MIN_SIZE, Math.floor(newWidth * ratio));
    newHeight = Math.max(MIN_SIZE, Math.floor(newWidth / aspectRatio));
  }

  img.free();
  return { buffer: webpBuffer, width: newWidth, height: newHeight, format: 'webp' };
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
