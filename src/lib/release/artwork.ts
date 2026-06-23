// src/lib/release/artwork.ts
// Artwork processing extracted from process-release.ts
// Handles magic byte validation, WebP conversion, R2 upload for cover + thumb + original

import { processImageToSquareWebP, processImageToFacebookOG, getImageDimensions, imageExtension, imageContentType } from '../image-processing';
import { errorResponse } from '../api-utils';
import type { createLogger } from '../api-utils';

export interface ArtworkResult {
  artworkUrl: string;
  thumbUrl: string;
  originalArtworkUrl: string;
  ogImageUrl: string;
  copiedFiles: { oldKey: string; newKey: string }[];
}

export interface ProcessArtworkParams {
  artworkKey: string | null;
  artworkSize: number;
  r2: R2Bucket;
  releaseFolder: string;
  publicDomain: string;
  copyObject: (sourceKey: string, destKey: string) => Promise<boolean>;
  log: ReturnType<typeof createLogger>;
}

const MAX_ARTWORK_FOR_PROCESSING = 5 * 1024 * 1024; // 5MB -- skip WASM processing for larger images
// Skip in-Worker WASM processing above this pixel count. Decoding to RGBA needs
// ~width*height*4 bytes of WASM memory, and a source that decodes past the
// Worker's 128MB ceiling traps ("unreachable") — a 3600x3600 (~52MB) JPEG did,
// which is what surfaced as the admin "<!DOCTYPE...not valid JSON" failure.
// 2500x2500 (~25MB decode) is a safe ceiling; larger art keeps its original as
// the cover (process it offline / re-upload <=2500px for an optimized WebP).
const MAX_PROCESS_PIXELS = 2500 * 2500;

/**
 * Process release artwork: validate magic bytes, convert to WebP (cover 800x800 + thumb 400x400),
 * copy original for buyer downloads. Returns URLs and list of copied files.
 * May return a Response (error) if magic byte validation fails.
 */
export async function processReleaseArtwork(params: ProcessArtworkParams): Promise<ArtworkResult | Response> {
  const { artworkKey, artworkSize, r2, releaseFolder, publicDomain, copyObject, log } = params;
  const placeholderUrl = `${publicDomain}/place-holder.webp`;

  const result: ArtworkResult = {
    artworkUrl: placeholderUrl,
    thumbUrl: placeholderUrl,
    originalArtworkUrl: '',
    ogImageUrl: '',
    copiedFiles: [],
  };

  if (!artworkKey) {
    return result;
  }

  log.info(`Artwork: ${artworkKey} (${(artworkSize / 1024).toFixed(0)}KB)`);

  if (artworkSize > MAX_ARTWORK_FOR_PROCESSING) {
    // Large image -- skip WASM processing, just copy original to avoid Worker timeout
    log.info(`Artwork too large for WASM processing (${(artworkSize / (1024 * 1024)).toFixed(1)}MB), copying original`);
    const artworkFilename = artworkKey.split('/').pop() || 'cover.webp';
    const newArtworkKey = `${releaseFolder}/${artworkFilename}`;
    const copied = await copyObject(artworkKey, newArtworkKey);
    if (copied) {
      result.copiedFiles.push({ oldKey: artworkKey, newKey: newArtworkKey });
      result.artworkUrl = `${publicDomain}/${newArtworkKey}`;
      result.originalArtworkUrl = result.artworkUrl;
      result.thumbUrl = result.artworkUrl;
    }
    return result;
  }

  // Download artwork for validation and processing
  const artworkObj = await r2.get(artworkKey);
  if (!artworkObj) {
    log.warn(`Failed to download artwork: ${artworkKey}`);
    return result;
  }

  const artworkBuffer = await artworkObj.arrayBuffer();
  const artworkBytes = new Uint8Array(artworkBuffer);

  // Validate magic bytes
  let magicValid = false;
  if (artworkBytes[0] === 0xFF && artworkBytes[1] === 0xD8 && artworkBytes[2] === 0xFF) {
    magicValid = true; // JPEG
  } else if (artworkBytes[0] === 0x89 && artworkBytes[1] === 0x50 && artworkBytes[2] === 0x4E && artworkBytes[3] === 0x47) {
    magicValid = true; // PNG
  } else if (artworkBytes[0] === 0x52 && artworkBytes[1] === 0x49 && artworkBytes[2] === 0x46 && artworkBytes[3] === 0x46
    && artworkBytes[8] === 0x57 && artworkBytes[9] === 0x45 && artworkBytes[10] === 0x42 && artworkBytes[11] === 0x50) {
    magicValid = true; // WebP
  } else if (artworkBytes[0] === 0x47 && artworkBytes[1] === 0x49 && artworkBytes[2] === 0x46 && artworkBytes[3] === 0x38) {
    magicValid = true; // GIF
  }
  if (!magicValid) {
    log.error(`Artwork file failed magic byte validation: ${artworkKey}`);
    // Return a Response to signal validation failure to the caller
    return errorResponse('Artwork file content does not match a valid image format (JPEG, PNG, WebP, GIF).', 400);
  }

  // Guard: a source too large to decode in-Worker would trap ("unreachable") or,
  // worse, OOM-crash the Worker (the original "<!DOCTYPE...not valid JSON" bug).
  // Read dimensions cheaply from the header and, if oversized, copy the original
  // as the cover instead of attempting the dangerous decode.
  const dims = getImageDimensions(artworkBytes);
  if (dims && dims.width * dims.height > MAX_PROCESS_PIXELS) {
    log.warn(`Artwork ${dims.width}x${dims.height} exceeds the in-Worker decode budget — copying original as cover (re-upload <=2500px for an optimized WebP).`);
    const artworkFilename = artworkKey.split('/').pop() || 'cover.webp';
    const newArtworkKey = `${releaseFolder}/${artworkFilename}`;
    const copied = await copyObject(artworkKey, newArtworkKey);
    if (copied) {
      result.copiedFiles.push({ oldKey: artworkKey, newKey: newArtworkKey });
      result.artworkUrl = `${publicDomain}/${newArtworkKey}`;
      result.originalArtworkUrl = result.artworkUrl;
      result.thumbUrl = result.artworkUrl;
    }
    return result;
  }

  // Process to WebP: 800x800 cover + 400x400 thumbnail.
  // SEQUENTIAL, not Promise.all: both calls share one Photon WASM heap, and
  // running them concurrently let one call grow/realloc WASM memory while the
  // other held a pixel view across an await — intermittently corrupting the
  // encode (the tell: many releases ended up with thumb.webp but no cover.webp).
  // Each call also self-caps working resolution (see processImageToSquareWebP),
  // so a high-res source no longer OOMs. The full-res original is copied
  // untouched for buyer downloads via copyObject() below.
  try {
    const cover = await processImageToSquareWebP(artworkBuffer, 800, 80);
    const thumb = await processImageToSquareWebP(artworkBuffer, 400, 75);

    // Upload cover + thumb + copy original in parallel
    const coverKey = `${releaseFolder}/cover${imageExtension(cover.format)}`;
    const thumbKey = `${releaseFolder}/thumb${imageExtension(thumb.format)}`;
    const origExt = artworkKey.split('.').pop() || 'jpg';
    const originalKey = `${releaseFolder}/original.${origExt}`;

    const [, , origCopied] = await Promise.all([
      r2.put(coverKey, cover.buffer, {
        httpMetadata: { contentType: imageContentType(cover.format), cacheControl: 'public, max-age=31536000, immutable' },
      }),
      r2.put(thumbKey, thumb.buffer, {
        httpMetadata: { contentType: imageContentType(thumb.format), cacheControl: 'public, max-age=31536000, immutable' },
      }),
      copyObject(artworkKey, originalKey),
    ]);

    result.artworkUrl = `${publicDomain}/${coverKey}`;
    result.thumbUrl = `${publicDomain}/${thumbKey}`;
    result.copiedFiles.push({ oldKey: artworkKey, newKey: coverKey });
    result.copiedFiles.push({ oldKey: artworkKey, newKey: thumbKey });
    log.info(`Created cover (${(cover.buffer.length / 1024).toFixed(0)}KB) + thumb (${(thumb.buffer.length / 1024).toFixed(0)}KB)`);

    if (origCopied) {
      result.originalArtworkUrl = `${publicDomain}/${originalKey}`;
      result.copiedFiles.push({ oldKey: artworkKey, newKey: originalKey });
      log.info(`Copied original artwork for downloads`);
    }

    // Facebook/social OG card (1200x630): square art centered on a blurred fill
    // so link shares aren't cropped to a square. Non-critical — skipped on any
    // failure. The source is already <=2500px here (past the guard above), so it
    // won't trip guardDecodeSize. Oversized art (which copies its original as the
    // cover and returns earlier) gets no OG here — backfill it after an offline
    // cover is made (see /api/admin/backfill-release-og).
    try {
      const og = await processImageToFacebookOG(artworkBuffer, 78);
      const ogKey = `${releaseFolder}/og${imageExtension(og.format)}`;
      await r2.put(ogKey, og.buffer, {
        httpMetadata: { contentType: imageContentType(og.format), cacheControl: 'public, max-age=31536000, immutable' },
      });
      result.ogImageUrl = `${publicDomain}/${ogKey}`;
      result.copiedFiles.push({ oldKey: artworkKey, newKey: ogKey });
      log.info(`Created OG card (${(og.buffer.length / 1024).toFixed(0)}KB)`);
    } catch (ogErr: unknown) {
      log.warn(`OG card generation failed (non-critical): ${ogErr}`);
    }
  } catch (imgErr: unknown) {
    // Fallback: copy original if image processing fails
    log.warn(`Image processing failed, copying original: ${imgErr}`);
    const artworkFilename = artworkKey.split('/').pop() || 'cover.webp';
    const newArtworkKey = `${releaseFolder}/${artworkFilename}`;
    const copied = await copyObject(artworkKey, newArtworkKey);
    if (copied) {
      result.copiedFiles.push({ oldKey: artworkKey, newKey: newArtworkKey });
      result.artworkUrl = `${publicDomain}/${newArtworkKey}`;
      result.originalArtworkUrl = result.artworkUrl;
      result.thumbUrl = result.artworkUrl;
    }
  }

  return result;
}
