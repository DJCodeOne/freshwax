// src/lib/order/vinyl-only.ts
// Vinyl-only releases (`vinylOnly: true` on the release) are sold purely as a
// physical record: their tracks are preview clips, not a download. Buying the
// record must never unlock audio files.

/**
 * True when an order item's audio must not be served: the item was stamped
 * `noDigital` at order time, or it's a vinyl purchase of a release that is
 * (now) vinyl-only. Only vinyl items need the release lookup.
 */
export async function isOrderItemAudioBlocked(
  item: Record<string, unknown>,
  getRelease: (id: string) => Promise<Record<string, unknown> | null>
): Promise<boolean> {
  if (item.noDigital === true) return true;
  if (item.type !== 'vinyl') return false;
  const releaseId = String(item.releaseId || item.productId || item.id || '');
  if (!releaseId) return false;
  const release = await getRelease(releaseId);
  return release?.vinylOnly === true;
}
