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

/**
 * Resize and crop image to a square, then convert to WebP
 * Works in Cloudflare Workers environment
 */
export async function processImageToSquareWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  targetSize: number,
  quality: number = 80
): Promise<ProcessedImage> {
  // Convert input to Uint8Array if needed
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  // Load image with photon
  const img = PhotonImage.new_from_byteslice(input);

  const originalWidth = img.get_width();
  const originalHeight = img.get_height();

  // Calculate center crop to make it square
  const minDimension = Math.min(originalWidth, originalHeight);
  const cropX = Math.floor((originalWidth - minDimension) / 2);
  const cropY = Math.floor((originalHeight - minDimension) / 2);

  // Crop to square from center
  const cropped = crop(img, cropX, cropY, minDimension, minDimension);
  img.free(); // Free original image memory

  // Resize to target size
  const resized = resize(cropped, targetSize, targetSize, SamplingFilter.Lanczos3);
  cropped.free(); // Free cropped image memory

  // Convert to WebP
  const webpBuffer = resized.get_bytes_webp();
  resized.free(); // Free resized image memory

  return {
    buffer: webpBuffer,
    width: targetSize,
    height: targetSize,
    format: 'webp'
  };
}

/**
 * Resize image maintaining aspect ratio, then convert to WebP
 */
export async function processImageToWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  maxWidth: number,
  maxHeight: number,
  quality: number = 80
): Promise<ProcessedImage> {
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  const img = PhotonImage.new_from_byteslice(input);

  const originalWidth = img.get_width();
  const originalHeight = img.get_height();

  // Calculate new dimensions maintaining aspect ratio
  let newWidth = originalWidth;
  let newHeight = originalHeight;

  if (originalWidth > maxWidth || originalHeight > maxHeight) {
    const widthRatio = maxWidth / originalWidth;
    const heightRatio = maxHeight / originalHeight;
    const ratio = Math.min(widthRatio, heightRatio);

    newWidth = Math.floor(originalWidth * ratio);
    newHeight = Math.floor(originalHeight * ratio);
  }

  // Resize if needed
  let processed: typeof img;
  if (newWidth !== originalWidth || newHeight !== originalHeight) {
    processed = resize(img, newWidth, newHeight, SamplingFilter.Lanczos3);
    img.free();
  } else {
    processed = img;
  }

  // Convert to WebP
  const webpBuffer = processed.get_bytes_webp();
  processed.free();

  return {
    buffer: webpBuffer,
    width: newWidth,
    height: newHeight,
    format: 'webp'
  };
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
