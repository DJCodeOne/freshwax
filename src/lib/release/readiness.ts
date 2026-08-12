// Completeness gate for auto-published releases.
//
// Auto-publish (see ./auto-approve.ts) removes the human review step for
// established partners. That step was the only thing catching half-processed
// releases, because every processing stage fails SOFT — artwork falls back to a
// placeholder, OG generation is swallowed, and MP3 conversion does not run on
// the partner upload path at all (it lives in two admin browser pages that call
// the operator's local audio processor on :8089). A release therefore publishes
// perfectly happily with a placeholder cover and 70MB WAVs as its previews.
//
// So: a release only auto-publishes when it is actually complete. Anything with
// a blocking problem falls back to the manual approval queue, where the operator
// sees it — a delayed release is recoverable, a broken live one is not.

const WEB_READY_AUDIO = /\.mp3(\?|$)/i;
const RAW_AUDIO = /\.(wav|aiff?|flac|alac)(\?|$)/i;

export interface ReleaseReadiness {
  /** True only when there are no blocking problems. */
  ready: boolean;
  /** Must be fixed before customers see it. */
  blocking: string[];
  /** Publishable, but the operator should know. */
  warnings: string[];
}

function isPlaceholder(url: unknown): boolean {
  return typeof url === 'string' && url.includes('place-holder');
}

/**
 * Inspect a built release document for anything that would make it broken or
 * misleading if it went live right now.
 */
export function assessReleaseReadiness(release: Record<string, unknown>): ReleaseReadiness {
  const blocking: string[] = [];
  const warnings: string[] = [];

  // --- Audio -------------------------------------------------------------
  const tracks = Array.isArray(release.tracks) ? (release.tracks as Record<string, unknown>[]) : [];
  if (tracks.length === 0) {
    blocking.push('Release has no tracks');
  }

  const missingAudio: string[] = [];
  const unconverted: string[] = [];
  const unknownFormat: string[] = [];

  tracks.forEach((t, i) => {
    const label = String(t.title || t.trackName || `Track ${i + 1}`);
    // previewUrl is what the storefront player streams; mp3Url is what a
    // digital buyer downloads. Both must be web-ready.
    const primary = String(t.mp3Url || t.url || '');
    const preview = String(t.previewUrl || '');

    if (!primary && !preview) {
      missingAudio.push(label);
      return;
    }
    const candidates = [primary, preview].filter(Boolean);
    if (candidates.some(u => RAW_AUDIO.test(u))) {
      unconverted.push(label);
    } else if (!candidates.every(u => WEB_READY_AUDIO.test(u))) {
      unknownFormat.push(label);
    }
  });

  if (missingAudio.length) {
    blocking.push(`No audio file for: ${missingAudio.join(', ')}`);
  }
  if (unconverted.length) {
    blocking.push(
      `Audio not converted to MP3 (still raw master) for: ${unconverted.join(', ')} — run the audio processor`
    );
  }
  if (unknownFormat.length) {
    warnings.push(`Audio is not an .mp3 for: ${unknownFormat.join(', ')}`);
  }

  // --- Artwork -----------------------------------------------------------
  const cover = release.coverArtUrl || release.coverUrl || release.artworkUrl;
  if (!cover || isPlaceholder(cover)) {
    blocking.push('Cover art missing or still the placeholder image');
  }
  if (!release.ogImageUrl) {
    // Cosmetic: only affects how a shared link previews on social.
    warnings.push('No social share image (og.webp) — link shares will fall back to the default card');
  }
  if (cover && release.thumbUrl === cover) {
    warnings.push('No separate thumbnail — artwork was too large to process, listings will load the full-size image');
  }

  // --- Ownership ---------------------------------------------------------
  // An unresolved owner means no payout attribution and £0 vinyl postage.
  if (!release.artistId && !release.submitterId) {
    blocking.push('Release has no owner (artistId/submitterId empty) — sales would not be credited to anyone');
  }

  // --- Pricing -----------------------------------------------------------
  const albumPrice = Number(release.pricePerSale ?? release.price ?? 0) || 0;
  const trackPrice = Number(release.trackPrice ?? 0) || 0;
  if (albumPrice <= 0 && trackPrice <= 0) {
    warnings.push('No digital price set — the release would be free');
  }
  if (release.vinylRelease === true && !(Number(release.vinylPrice) > 0)) {
    blocking.push('Marked as a vinyl release but has no vinyl price');
  }

  return { ready: blocking.length === 0, blocking, warnings };
}
