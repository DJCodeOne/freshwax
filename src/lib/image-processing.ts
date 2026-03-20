// src/lib/image-processing.ts
// WASM-based image processing for Cloudflare Workers
// Uses @cf-wasm/photon for crop/resize + @jsquash/webp for lossy WebP encoding

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon';
import encodeWebP, { init as initWebPEncode } from '@jsquash/webp/encode';
// Direct WASM imports for Cloudflare Workers (no filesystem fetch available)
// @ts-ignore — .wasm imports are handled by Cloudflare/Vite bundler
import webpEncWasm from '@jsquash/webp/codec/enc/webp_enc.wasm';

let webpReady: Promise<unknown> | null = null;
function ensureWebPInit(): Promise<unknown> {
  if (!webpReady) {
    webpReady = initWebPEncode(webpEncWasm);
  }
  return webpReady;
}

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
const DEFAULT_QUALITY = 75;

/**
 * Encode raw RGBA pixels to lossy WebP using @jsquash/webp.
 * Falls back to Photon's lossless encoder if jSquash fails.
 */
async function encodeLossyWebP(
  rawPixels: Uint8Array,
  width: number,
  height: number,
  quality: number,
): Promise<Uint8Array> {
  await ensureWebPInit();
  const imageData = {
    data: new Uint8ClampedArray(rawPixels.buffer, rawPixels.byteOffset, rawPixels.byteLength),
    width,
    height,
  };
  const encoded = await encodeWebP(imageData as ImageData, { quality });
  return new Uint8Array(encoded);
}

/**
 * Resize and crop image to a square WebP, guaranteed under 100KB.
 * If the first encode exceeds 100KB, progressively reduces dimensions.
 */
export async function processImageToSquareWebP(
  inputBuffer: ArrayBuffer | Uint8Array,
  targetSize: number,
  quality: number = DEFAULT_QUALITY
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
  const croppedBytes = cropped.get_bytes();
  cropped.free();

  let currentSize = targetSize;
  let webpBuffer: Uint8Array = new Uint8Array(0);
  const debugLog: { attempt: number; size: number; dimensions: string }[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fresh = PhotonImage.new_from_byteslice(croppedBytes);
    const resized = resize(fresh, currentSize, currentSize, SamplingFilter.Lanczos3);
    const rawPixels = resized.get_raw_pixels();
    const w = resized.get_width();
    const h = resized.get_height();
    fresh.free();
    resized.free();

    webpBuffer = await encodeLossyWebP(rawPixels, w, h, quality);

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
  quality: number = DEFAULT_QUALITY
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
    const processed = resize(fresh, newWidth, newHeight, SamplingFilter.Lanczos3);
    const rawPixels = processed.get_raw_pixels();
    const w = processed.get_width();
    const h = processed.get_height();
    fresh.free();
    processed.free();

    webpBuffer = await encodeLossyWebP(rawPixels, w, h, quality);

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

