// src/lib/image-processing.ts
// WASM-based image processing for Cloudflare Workers
// Uses @cf-wasm/photon for crop/resize + @jsquash/webp for lossy WebP encoding

import { PhotonImage, SamplingFilter, crop, gaussian_blur, resize, watermark } from '@cf-wasm/photon';
import encodeWebP, { init as initWebPEncode } from '@jsquash/webp/encode';
// Direct WASM imports for Cloudflare Workers (no filesystem fetch available)
// @ts-expect-error — .wasm imports have no type declarations; handled by Cloudflare/Vite bundler at build time
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

// Working-resolution cap. Sources larger than this on the long side are
// downscaled *before* the crop/resize loop (see processImageToSquareWebP /
// processImageToWebP). A 3600x3600 image decodes to ~52MB RGBA and cropping
// doubles that; without the cap, processing two sizes — or several images —
// concurrently blew the Worker's 128MB limit -> uncatchable OOM -> Cloudflare
// HTML error page -> the admin UI's response.json() failing on "<!DOCTYPE".
// 2000px is ample for any cover/thumb. No-op for already-small images.
const WORK_CAP = 2000;

/**
 * If the decoded image's long side exceeds WORK_CAP, resize it down in place
 * (Lanczos3) and return the smaller PhotonImage, freeing the original. Otherwise
 * returns the image unchanged. Keeps peak Worker memory bounded regardless of
 * source resolution. Caller owns freeing the returned image.
 */
function capWorkingImage(img: PhotonImage): PhotonImage {
  const w = img.get_width();
  const h = img.get_height();
  const longSide = Math.max(w, h);
  if (longSide <= WORK_CAP) return img;
  const ratio = WORK_CAP / longSide;
  const shrunk = resize(
    img,
    Math.max(1, Math.round(w * ratio)),
    Math.max(1, Math.round(h * ratio)),
    SamplingFilter.Lanczos3,
  );
  img.free();
  return shrunk;
}

/**
 * Cheaply read pixel dimensions from an image header WITHOUT decoding it.
 * Supports JPEG, PNG, WebP (VP8/VP8L/VP8X) and GIF; returns null if unknown or
 * unparseable. Lets callers skip a full WASM decode of a source so large it
 * would exhaust the Worker's 128MB memory and trap ("unreachable").
 */
export function getImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const n = bytes.length;
  // PNG — IHDR width/height (big-endian) at offsets 16 / 20
  if (n >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  // GIF — logical screen width/height (little-endian) at offsets 6 / 8
  if (n >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  // WebP — RIFF....WEBP then a VP8 / VP8L / VP8X chunk
  if (n >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const fmt = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fmt === 'VP8 ') {
      const w = (bytes[26] | (bytes[27] << 8)) & 0x3FFF;
      const h = (bytes[28] | (bytes[29] << 8)) & 0x3FFF;
      if (w > 0 && h > 0) return { width: w, height: h };
    } else if (fmt === 'VP8L') {
      const v = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return { width: 1 + (v & 0x3FFF), height: 1 + ((v >>> 14) & 0x3FFF) };
    } else if (fmt === 'VP8X') {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h };
    }
  }
  // JPEG — scan segments for a SOF marker (C0-CF, excluding C4/C8/CC)
  if (n >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let off = 2;
    while (off + 9 < n) {
      if (bytes[off] !== 0xFF) { off++; continue; }
      let marker = bytes[off + 1];
      while (marker === 0xFF && off + 1 < n) { off++; marker = bytes[off + 1]; }
      const seg = off + 2;
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (seg + 6 < n) {
          const h = (bytes[seg + 3] << 8) | bytes[seg + 4];
          const w = (bytes[seg + 5] << 8) | bytes[seg + 6];
          if (w > 0 && h > 0) return { width: w, height: h };
        }
        return null;
      }
      if (seg + 1 >= n) break;
      const len = (bytes[seg] << 8) | bytes[seg + 1];
      if (len < 2) break;
      off = seg + len;
    }
  }
  return null;
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

  // Cap working resolution before the crop so a huge source can't OOM the Worker
  const img = capWorkingImage(PhotonImage.new_from_byteslice(input));

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

  // Cap working resolution before processing so a huge source can't OOM the Worker
  const img = capWorkingImage(PhotonImage.new_from_byteslice(input));

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

/**
 * Generate a 1200x630 Facebook OG-friendly image: source image centered as a
 * 630x630 square on top of a heavily-blurred enlarged copy of itself filling
 * the side bars. Matches Facebook's preferred 1.91:1 aspect ratio so shares
 * stop cropping the top + bottom of square cover art.
 *
 * Roughly +200-400ms on top of the existing square processing on Workers.
 */
export async function processImageToFacebookOG(
  inputBuffer: ArrayBuffer | Uint8Array,
  quality: number = 78
): Promise<ProcessedImage> {
  const input = inputBuffer instanceof Uint8Array
    ? inputBuffer
    : new Uint8Array(inputBuffer);

  const FB_W = 1200;
  const FB_H = 630;
  const FG_SIZE = 630;
  const FG_X = Math.floor((FB_W - FG_SIZE) / 2); // 285

  // Foreground: center-crop square then resize to 630x630
  const fgSrc = PhotonImage.new_from_byteslice(input);
  const ow = fgSrc.get_width();
  const oh = fgSrc.get_height();
  const minDim = Math.min(ow, oh);
  const fgCropX = Math.floor((ow - minDim) / 2);
  const fgCropY = Math.floor((oh - minDim) / 2);
  const fgSquare = crop(fgSrc, fgCropX, fgCropY, fgCropX + minDim, fgCropY + minDim);
  fgSrc.free();
  const foreground = resize(fgSquare, FG_SIZE, FG_SIZE, SamplingFilter.Lanczos3);
  fgSquare.free();

  // Background: enlarge source to >=1200x630 maintaining aspect, center-crop
  // to 1200x630, then heavy gaussian blur. Square inputs become 1200x1200
  // pre-crop; non-square get scaled to fill.
  const bgSrc = PhotonImage.new_from_byteslice(input);
  const bgAspect = ow / oh;
  let bgW: number;
  let bgH: number;
  if (bgAspect >= FB_W / FB_H) {
    bgH = FB_H;
    bgW = Math.ceil(FB_H * bgAspect);
  } else {
    bgW = FB_W;
    bgH = Math.ceil(FB_W / bgAspect);
  }
  const bgScaled = resize(bgSrc, bgW, bgH, SamplingFilter.Nearest);
  bgSrc.free();
  const bgCropX = Math.floor((bgW - FB_W) / 2);
  const bgCropY = Math.floor((bgH - FB_H) / 2);
  const bgCanvas = crop(bgScaled, bgCropX, bgCropY, bgCropX + FB_W, bgCropY + FB_H);
  bgScaled.free();
  // Heavy blur — radius ~40 hides any cover art detail, leaving a colored haze.
  gaussian_blur(bgCanvas, 40);

  // Composite foreground over blurred background. watermark() uses bigint coords.
  watermark(bgCanvas, foreground, BigInt(FG_X), BigInt(0));
  foreground.free();

  const rawPixels = bgCanvas.get_raw_pixels();
  const w = bgCanvas.get_width();
  const h = bgCanvas.get_height();
  bgCanvas.free();

  const webpBuffer = await encodeLossyWebP(rawPixels, w, h, quality);

  return {
    buffer: webpBuffer,
    width: w,
    height: h,
    format: 'webp',
    debug: [{ attempt: 0, size: webpBuffer.length, dimensions: `${w}x${h}` }],
  };
}

/** Get file extension for a processed image format */
export function imageExtension(format: string): string {
  return format === 'jpeg' ? '.jpg' : '.webp';
}

/** Get MIME content type for a processed image format */
export function imageContentType(format: string): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

