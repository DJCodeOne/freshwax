// image-processor.ts - Image conversion for merch products
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
  quality: number = 85
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

    // Process to 800x800 (WebP or JPEG, whichever is smaller)
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
