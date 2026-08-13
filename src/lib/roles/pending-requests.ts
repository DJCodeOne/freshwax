// src/lib/roles/pending-requests.ts
// Resolving pendingRoleRequests after a role is granted.
//
// Why this exists: approve-partner.ts granted roles on users/artists/partners
// but never touched the pendingRoleRequests doc, so every partner approved
// through that path stayed "pending" forever. Combined with a missing
// (status, requestedAt) composite index — which made the Approvals tab render
// empty — 13 already-approved partners silently piled up between Dec 2025 and
// Aug 2026. Granting a role and recording that grant must happen together.

import { queryCollection, updateDocument } from '../firebase-rest';

export type UserRoles = Record<string, unknown>;

/**
 * Which `users.roles` key a given request roleType grants.
 *
 * Mirrors the mapping in admin/partner-applications.ts. Note that merchSeller,
 * merch and merchSupplier all grant `merchSupplier` — the request form says
 * "merchSeller" but the role that exists is `merchSupplier`. Returns null for
 * anything unrecognised so callers leave the request alone rather than
 * guessing.
 */
export function grantedRoleKey(roleType: string | undefined | null): string | null {
  if (!roleType) return null;
  if (roleType === 'artist' || roleType === 'dj') return 'artist';
  if (roleType === 'merchSupplier' || roleType === 'merch' || roleType === 'merchSeller') return 'merchSupplier';
  if (roleType === 'vinylSeller') return 'vinylSeller';
  return null;
}

/**
 * Mark a user's pending role requests as approved — but only the ones whose
 * role the user now actually holds.
 *
 * The gate matters: approve-partner.ts grants artist and merchSupplier only. If
 * a user also has a pending vinylSeller request, blanket-resolving everything
 * would bury a request that was never actually granted. Anything not satisfied
 * by `roles` stays pending and stays visible in the Approvals tab.
 *
 * Never throws — a bookkeeping failure must not roll back a successful grant.
 * Returns the number of requests resolved.
 */
export async function resolvePendingRoleRequests(
  userId: string,
  roles: UserRoles
): Promise<number> {
  if (!userId) return 0;
  try {
    // Two equality filters — served by single-field indexes, no composite needed.
    const pending = await queryCollection('pendingRoleRequests', {
      filters: [
        { field: 'userId', op: 'EQUAL', value: userId },
        { field: 'status', op: 'EQUAL', value: 'pending' },
      ],
      limit: 50,
    });

    if (!pending || pending.length === 0) return 0;

    const now = new Date().toISOString();
    let resolved = 0;

    for (const req of pending) {
      const key = grantedRoleKey(req.roleType as string);
      if (!key || roles[key] !== true) continue; // not granted — leave it pending
      await updateDocument('pendingRoleRequests', req.id as string, {
        status: 'approved',
        processedAt: now,
      });
      resolved++;
    }

    return resolved;
  } catch {
    return 0;
  }
}
