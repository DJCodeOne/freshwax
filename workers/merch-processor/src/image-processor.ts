// image-processor.ts - Image conversion for merch products
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
 * Process product images: creates main image (800x800) + thumbnail (400x400)
 */
export async function processProductImages(
  submissionId: string,
  imageKeys: string[],
  productId: string,
  env: Env
): Promise<{ images: string[]; mainImage: string; thumbnail: string }> {
  console.log(`[Image] Processing ${imageKeys.length} product images`);

  const processedImages: string[] = [];
  let mainImage = '';
  let thumbnail = '';

  for (let i = 0; i < imageKeys.length; i++) {
    const imageKey = imageKeys[i];
    console.log(`[Image] Processing image ${i + 1}/${imageKeys.length}: ${imageKey}`);

    // Download image
    const imageObj = await env.MERCH_BUCKET.get(imageKey);
    if (!imageObj) {
      console.warn(`[Image] Image not found: ${imageKey}`);
      continue;
    }

    const imageBuffer = await imageObj.arrayBuffer();
    console.log(`[Image] Downloaded: ${imageBuffer.byteLength} bytes`);

    // Process to 800x800 WebP
    const processed = await processImageToSquareWebP(imageBuffer, 800);
    console.log(`[Image] Processed: ${processed.buffer.byteLength} bytes (${processed.format})`);

    // Upload to merch bucket with dynamic extension
    const ext = imageExtension(processed.format);
    const outputKey = `merch/${productId}/image-${i + 1}${ext}`;
    await env.MERCH_BUCKET.put(outputKey, processed.buffer, {
      httpMetadata: {
        contentType: imageContentType(processed.format),
        cacheControl: 'public, max-age=31536000, immutable'
      }
    });

    const imageUrl = `${env.R2_PUBLIC_DOMAIN}/${outputKey}`;
    processedImages.push(imageUrl);
    console.log(`[Image] Uploaded: ${imageUrl}`);

    // First image becomes main image
    if (i === 0) {
      mainImage = imageUrl;

      // Also create thumbnail for first image
      const thumb = await processImageToSquareWebP(imageBuffer, 400);
      const thumbExt = imageExtension(thumb.format);
      const thumbKey = `merch/${productId}/thumbnail${thumbExt}`;
      await env.MERCH_BUCKET.put(thumbKey, thumb.buffer, {
        httpMetadata: {
          contentType: imageContentType(thumb.format),
          cacheControl: 'public, max-age=31536000, immutable'
        }
      });
      thumbnail = `${env.R2_PUBLIC_DOMAIN}/${thumbKey}`;
      console.log(`[Image] Thumbnail: ${thumbnail} (${thumb.format})`);
    }
  }

  // Use placeholder if no images
  if (processedImages.length === 0) {
    const placeholder = `${env.R2_PUBLIC_DOMAIN}/place-holder.webp`;
    processedImages.push(placeholder);
    mainImage = placeholder;
    thumbnail = placeholder;
  }

  return { images: processedImages, mainImage, thumbnail };
}
