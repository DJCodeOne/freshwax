// Auto-publish rule for established partners.
//
// A partner who already has a live release on the platform has been vetted
// once by a human. Their subsequent uploads go straight live — the same way
// DJ mixes publish on upload — instead of sitting in the admin approval
// queue. Only a partner's FIRST release still needs manual approval.

import { createLogger } from '../api-utils';

const log = createLogger('[auto-approve]');

/** How many live releases a partner needs before uploads publish themselves. */
export const AUTO_PUBLISH_MIN_LIVE_RELEASES = 1;

/** Ownership fields a release may use to point back at its partner. */
const OWNER_FIELDS = ['submitterId', 'artistId'] as const;

export interface AutoPublishFields {
  status: string;
  published: boolean;
  approved: boolean;
  approvedAt: string | null;
  autoApproved: boolean;
}

/**
 * Count a partner's live releases, ignoring the one being uploaded right now.
 * Releases are matched on either ownership field because older rows were
 * written before `submitterId` became the canonical one.
 */
export function countLiveReleases(
  releases: Array<Record<string, unknown>>,
  ownerId: string,
  excludeReleaseId?: string
): number {
  if (!ownerId) return 0;

  const seen = new Set<string>();
  for (const release of releases) {
    const id = String(release.id || '');
    if (!id || id === excludeReleaseId || seen.has(id)) continue;
    if (release.status !== 'live') continue;

    const owned = OWNER_FIELDS.some((field) => release[field] === ownerId);
    if (!owned) continue;

    seen.add(id);
  }
  return seen.size;
}

/**
 * Decide whether this upload can publish itself. `fetchByOwnerField` is
 * supplied by the caller so this works with both the service-account and
 * the REST query helpers.
 *
 * Errors are swallowed deliberately: if we cannot prove the partner is
 * established, the release falls back to the manual approval queue rather
 * than publishing something unvetted.
 */
export async function isEstablishedPartner(
  ownerId: string,
  fetchByOwnerField: (field: string, value: string) => Promise<Array<Record<string, unknown>>>,
  excludeReleaseId?: string
): Promise<boolean> {
  if (!ownerId) return false;

  try {
    const results = await Promise.all(
      OWNER_FIELDS.map((field) => fetchByOwnerField(field, ownerId))
    );
    const liveCount = countLiveReleases(results.flat(), ownerId, excludeReleaseId);
    const established = liveCount >= AUTO_PUBLISH_MIN_LIVE_RELEASES;

    log.info(
      `Owner ${ownerId} has ${liveCount} live release(s) -> ${established ? 'auto-publish' : 'manual approval'}`
    );
    return established;
  } catch (e: unknown) {
    log.warn(`Could not check catalogue for ${ownerId}, defaulting to manual approval:`, e);
    return false;
  }
}

/** The status fields a release is created with, given the auto-publish decision. */
export function releaseStatusFields(autoPublish: boolean, now: string): AutoPublishFields {
  return autoPublish
    ? { status: 'live', published: true, approved: true, approvedAt: now, autoApproved: true }
    : { status: 'pending', published: false, approved: false, approvedAt: null, autoApproved: false };
}
