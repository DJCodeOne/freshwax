// src/lib/serp-title.ts
// Fit a page title into the search-result <title> budget.
//
// The old rule chopped at a fixed character count and appended "...", so it
// cut mid-word ("Classic Unisex T-S...", "Live Sets Ov...") and dropped the
// end of the title. For numbered products ("... T-Shirt 1/2/3") that end is the
// only thing that tells them apart, so three pages shared one <title>.
//
// Now: cut at a word boundary, and when the title ends in a number keep that
// number after the ellipsis ("Underground Lair Recordings Classic Unisex… 3").

export function truncateSerpTitle(title: string, maxLength: number): string {
  const text = title.trim();
  if (text.length <= maxLength) return text;

  const trailingNumber = text.match(/\s(\d{1,4})$/)?.[1];
  const keep = trailingNumber ? ` ${trailingNumber}` : '';
  const budget = maxLength - 1 - keep.length; // 1 = the ellipsis

  let cut = text.slice(0, budget);
  // Back up to a word boundary unless the cut already ends on one — and not
  // if that would throw away most of the budget (one very long word).
  if (!/\s/.test(text.charAt(budget))) {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > budget * 0.6) cut = cut.slice(0, lastSpace);
  }
  cut = cut.replace(/[\s,;:.\-–—|/&+]+$/, '');

  return `${cut}…${keep}`;
}
