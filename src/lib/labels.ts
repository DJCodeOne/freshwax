// src/lib/labels.ts
// Label hub helpers: shared slug + grouping logic used by /label/[slug],
// the sitemap and internal label links. Keep slugging in ONE place — the
// slug is part of public URLs, so page/sitemap/links must always agree.

/** Display name of a release's label (same precedence as releases.astro) */
export function releaseLabelName(release: Record<string, unknown>): string {
  return String(
    release.labelName || release.label || release.recordLabel || release.copyrightHolder || 'Unknown Label'
  );
}

/** URL slug for a label name: "Underground Lair Recordings" -> "underground-lair-recordings" */
export function labelSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface LabelGroup {
  name: string;
  slug: string;
  releases: Record<string, unknown>[];
}

/** Group live releases into label hubs (skips Unknown Label). */
export function groupReleasesByLabel(releases: Record<string, unknown>[]): LabelGroup[] {
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const r of releases) {
    const name = releaseLabelName(r);
    if (name === 'Unknown Label') continue;
    const list = byName.get(name) || [];
    list.push(r);
    byName.set(name, list);
  }
  return [...byName.entries()]
    .map(([name, rels]) => ({ name, slug: labelSlug(name), releases: rels }))
    .sort((a, b) => b.releases.length - a.releases.length);
}
