// src/services/tenant-member-recipients.ts
//
// fr-agui P1-TEAM-b — "who are this tenant's MEMBERS?", for notification lists
// AND for the 1-of-any decide arm.
//
// ⭐ GEORGE, 2026-10-15, VERBATIM: "all notifications/approvals/questions are sent
// to all members, each member can configure their notification channels."
//
// A member of tenant T is the union of
//   1. every `user_roles` row in T, ANY role (`workspace-admin` or
//      `workspace-member`), folded to DISTINCT user ids; and
//   2. every ENABLED Keycloak user whose `tenant_id` attribute is T
//      (`keycloak.listTenantUserIds`) — a Keycloak-only member has no
//      `user_roles` row and is still a member (their signed token's tenant IS T).
//
// DB ids come first (stable), then directory ids not already present.
//
// ── TWO CONSUMERS, TWO FAILURE DIRECTIONS ────────────────────────────────────────
//
//   * NOTIFY (`listTenantMemberRecipients`) is FILTERED BY THE DIRECTORY and fails
//     CLOSED on content (P1-TEAM-b audit B1). A `user_roles` row is NOT proof of
//     membership: a user re-homed to another tenant, or disabled, keeps their old rows,
//     and would keep receiving T's approvals, execution events and bug reports. So a
//     DB-half id is told only when the directory says it is ENABLED and HOMED in T —
//     in the enabled `tenant_id = T` list, else `userHomedIn(id, T)` (the legacy
//     no-attribute user homed in their own id; the decide seats' own rule). When the
//     directory cannot be read the result is EMPTY with `realmError` set (and reported):
//     the "DB members only" fallback is exactly the population that holds stale rows, so
//     an outage tells NOBODY beyond what the raise site addressed explicitly (its
//     roster). The approval itself is durable; telling fewer people is recoverable,
//     telling a former member another tenant's content is not.
//   * DECIDE (`isTenantMemberForDecision`, `soloTenantMembership`) fails CLOSED: a
//     directory outage never ADMITS anybody the DB half does not already vouch for,
//     and never proves a tenant solo. Those reads are always `{ fresh: true }`.
//
// ⛔ STRICT TENANT SEPARATION. Every id returned is a member of exactly the tenant
// asked about — the DB half is `WHERE tenant_id = T`, the directory half re-checks
// the attribute client-side (keycloak.ts). Nothing here can widen across a tenant.
// A malformed tenant id answers [] (fail closed) without querying either half.

import { and, eq } from 'drizzle-orm';
import { db, userRoles } from '../db/client';
import { keycloak } from './keycloak';
import { userHomedIn } from './user-home-tenant';
import { isAgentMemberId } from '../domain/engagement/agent-members';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { isValidUuid } from '../utils/tenant';
import { createSingleFlight } from '../lib/single-flight';

/** DISTINCT `user_roles.user_id` in T, any role. THROWS on a DB failure. */
async function listDbMembers(tenantId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ user_id: userRoles.user_id })
    .from(userRoles)
    .where(eq(userRoles.tenant_id, tenantId));
  return rows.map((r) => r.user_id).sort();
}

/** Is there a `user_roles` row (any role) for (user, T)? THROWS on a DB failure. */
async function hasDbMembership(tenantId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ user_id: userRoles.user_id })
    .from(userRoles)
    .where(and(eq(userRoles.tenant_id, tenantId), eq(userRoles.user_id, userId)))
    .limit(1);
  return rows.length > 0;
}

export interface TenantMemberRecipients {
  userIds: string[];
  /**
   * Set when the Keycloak half could not be read; `userIds` is then EMPTY (fail closed:
   * nobody beyond the raise site's own explicit roster is told).
   */
  realmError?: unknown;
  /** `user_roles` ids NOT told: re-homed, disabled, deleted, or unverifiable. */
  droppedDbIds?: string[];
}

function unionInOrder(...lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const id of list) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * NOTIFY: every CURRENT member of `tenantId` — the enabled Keycloak users homed in T,
 * plus each `user_roles` id the directory confirms is active and homed in T. A stale
 * `user_roles` row (re-homed / disabled / deleted user) is DROPPED and logged. A
 * directory outage returns `{ userIds: [], realmError }` (fail closed, reported). A DB
 * failure THROWS — the caller decides whether a notification may be skipped.
 */
export async function listTenantMemberRecipients(
  tenantId: string,
  opts: { fresh?: boolean } = {},
): Promise<TenantMemberRecipients> {
  if (!tenantId || !isValidUuid(tenantId)) return { userIds: [] };
  const dbIds = await listDbMembers(tenantId);
  let realmIds: string[];
  try {
    realmIds = await keycloak.listTenantUserIds(tenantId, { fresh: opts.fresh === true });
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      // Fallback only: an IntegrationError from listTenantUserIds carries its own path.
      path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
      degradedTo:
        `tenant-member recipients for tenant ${tenantId} = NOBODY beyond the explicit roster ` +
        `(directory unreadable; ${dbIds.length} user_roles id(s) unverified, fail closed)`,
    });
    return { userIds: [], realmError: err };
  }
  const realmSet = new Set(realmIds);
  const confirmed: string[] = [];
  const dropped: string[] = [];
  for (const id of dbIds) {
    if (!id) continue;
    // An agent member (fr #1683) is not a Keycloak user: its `user_roles` row IS its
    // membership, so it is told like any member (owner direction 2026-10-31: approvals
    // multicast to every channel the tenant configured, the agent's mcp link included).
    if (realmSet.has(id) || isAgentMemberId(id)) {
      confirmed.push(id);
      continue;
    }
    // Not in the enabled `tenant_id = T` list: a legacy no-attribute user homed in their
    // own id is still a member; a re-homed / disabled / deleted one is not.
    try {
      if (await userHomedIn(id, tenantId)) confirmed.push(id);
      else dropped.push(id);
    } catch (err) {
      dropped.push(id);
      reportSwallowedFailure(err, {
        service: 'keycloak',
        method: 'GET',
        path: '/admin/realms/{realm}/users/{id}',
        degradedTo: `user ${id} NOT notified for tenant ${tenantId} (home tenant unverifiable, fail closed)`,
      });
    }
  }
  if (dropped.length > 0) {
    console.warn(
      `[tenant-member-recipients] tenant ${tenantId}: ${dropped.length} user_roles id(s) not ` +
        `notified (not active / not homed in this tenant): ${dropped.join(', ')}`,
    );
  }
  return {
    userIds: unionInOrder(confirmed, realmIds),
    ...(dropped.length > 0 ? { droppedDbIds: dropped } : {}),
  };
}

/**
 * DECIDE: is `userId` a member of `tenantId`? Fails CLOSED.
 *
 * The DB half is asked first and short-circuits (no directory round trip for a
 * `user_roles` member). Otherwise the directory is read FRESH; a directory or DB
 * failure answers `false` — it never admits anybody on an unverified read.
 */
/**
 * P1-TEAM-c audit 2: the SAME decide membership as `isTenantMemberForDecision`, but a read
 * failure THROWS instead of answering `false`. For a caller that must tell "not a member"
 * from "could not tell" — `narrowLinkedAccountsForDecision` attributes a chat decision to
 * the ONE linked account that is a member, and an outage hiding a second member would make
 * that attribution wrong rather than refused.
 */
export async function isTenantMemberForDecisionOrThrow(
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId || !userId || !isValidUuid(tenantId)) return false;
  if (await hasDbMembership(tenantId, userId)) return true;
  return (await keycloak.listTenantUserIds(tenantId, { fresh: true })).includes(userId);
}

export async function isTenantMemberForDecision(
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId || !userId || !isValidUuid(tenantId)) return false;
  try {
    return await isTenantMemberForDecisionOrThrow(tenantId, userId);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
      degradedTo: `user ${userId} NOT treated as a member of tenant ${tenantId} (fail closed: decide arm refused)`,
    });
    return false;
  }
}

/**
 * DECIDE: the tenant's COMPLETE member set, or `null` when it cannot be read
 * completely (a directory or DB failure). `soloTenantMemberIsTenantGod` reads this:
 * a tenant is solo only when the WHOLE union is exactly one person, so a partial
 * (DB-only) view can never prove it — fail closed.
 */
export async function readCompleteTenantMembership(
  tenantId: string | null | undefined,
): Promise<Set<string> | null> {
  if (!tenantId || !isValidUuid(tenantId)) return new Set();
  try {
    const dbIds = await listDbMembers(tenantId);
    const realmIds = await keycloak.listTenantUserIds(tenantId, { fresh: true });
    return new Set(unionInOrder(dbIds, realmIds));
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
      degradedTo: `tenant ${tenantId} membership unknown — not provably solo (fail closed)`,
    });
    return null;
  }
}

// ── LIST PATH ONLY: the (tenant, user) TTL cache ─────────────────────────────────────
//
// `GET /api/approvals` (the sidebar badge polls it) needs two membership facts about the
// CALLER — "is a current member?" (gates the tenant_member lane) and "is the solo tenant's
// god?" (the lane's requester exemption). Read uncached, both cost a Keycloak round trip on
// EVERY poll, so directory latency or an outage landed on the hot path (P1-TEAM-b audit 3).
//
// ⛔ WHY CACHING IS SAFE HERE AND NOWHERE ELSE — THE CACHE NEVER REACHES A DECISION.
// `readListLaneMembership` is consumed ONLY by `handleListMyApprovals`: it decides which
// rows a caller is SHOWN, never whether a decision is accepted. Every decide seat (the
// PUT handler's `resolveDecideEligibility`, the Telegram seat through
// `lib/chat-seat-tenant-member.ts`) still calls `isTenantMemberForDecision` /
// `readCompleteTenantMembership` above — uncached, `{ fresh: true }`, fail closed. So a
// stale "is member" can at most keep a row VISIBLE to an ex-member for <= TTL; their click
// re-reads the directory and is refused. The decide path is deliberately NOT cached
// (rather than "cached but narrow-only") because a decision is rare and irreversible
// while the list is frequent and read-only — the trade only pays on the list side.
//
// Visibility staleness is bounded by `LIST_LANE_CACHE_TTL_MS` (60s — the same bound the
// notify path's `keycloak.listTenantUserIds` cache already accepts for re-homing), and
// the miss reads the directory `{ fresh: true }` so the two caches never stack to 120s.
//
// ⚠️ A DEGRADED VERDICT (directory or DB read failed) is cached too, but only for
// `LIST_LANE_DEGRADED_TTL_MS`. That is safe because a degraded verdict can only NARROW:
// it is the rostered-only lane (no membership proven), or — for a `user_roles` member —
// the member lane WITHOUT the solo-god requester exemption. Caching it bounds an outage
// to one directory attempt per (tenant, user) per 10s instead of one per poll, and the
// short TTL lets the full lane come back promptly once the directory recovers.

const LIST_LANE_CACHE_TTL_MS = 60_000;
const LIST_LANE_DEGRADED_TTL_MS = 10_000;
const LIST_LANE_CACHE_MAX_ENTRIES = 5_000;

interface ListLaneMembership {
  /** The caller is a current member of the tenant: OR the tenant_member lane in. */
  isMember: boolean;
  /** The caller is the solo tenant's only member (`soloTenantMemberIsTenantGod`'s rule). */
  requesterMayDecide: boolean;
  /** A read failed; the verdict is the narrowed, fail-closed one. */
  degraded: boolean;
}

const listLaneCache = new Map<string, { at: number; verdict: ListLaneMembership }>();
const listLaneFlight = createSingleFlight<ListLaneMembership>();

async function computeListLaneMembership(
  tenantId: string,
  userId: string,
): Promise<ListLaneMembership> {
  let isMember = false;
  let realmIds: string[] | undefined;
  try {
    isMember = await hasDbMembership(tenantId, userId);
    if (!isMember) {
      realmIds = await keycloak.listTenantUserIds(tenantId, { fresh: true });
      isMember = realmIds.includes(userId);
    }
    if (!isMember) return { isMember: false, requesterMayDecide: false, degraded: false };
    // Same rule as `soloTenantMemberIsTenantGod`: the COMPLETE union is exactly the caller.
    // At most ONE directory read per miss — reuse the list already fetched above.
    const dbIds = await listDbMembers(tenantId);
    realmIds ??= await keycloak.listTenantUserIds(tenantId, { fresh: true });
    const members = new Set(unionInOrder(dbIds, realmIds));
    return {
      isMember: true,
      requesterMayDecide: members.size === 1 && members.has(userId),
      degraded: false,
    };
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'keycloak',
      method: 'GET',
      path: '/admin/realms/{realm}/users?q=tenant_id:{tenant}',
      degradedTo:
        `approvals list for user ${userId} in tenant ${tenantId}: ` +
        (isMember
          ? 'tenant_member lane WITHOUT the solo-god requester exemption (fail closed)'
          : 'rostered lanes only (membership unverifiable, fail closed)'),
    });
    return { isMember, requesterMayDecide: false, degraded: true };
  }
}

/**
 * LIST PATH ONLY — the caller's membership facts for `GET /api/approvals`, TTL-cached per
 * (tenantId, userId). NEVER THROWS: a failed read answers the narrowed verdict. ⛔ Never
 * use it to accept a decision — see the block comment above.
 */
export async function readListLaneMembership(
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): Promise<ListLaneMembership> {
  if (!tenantId || !userId || !isValidUuid(tenantId)) {
    return { isMember: false, requesterMayDecide: false, degraded: false };
  }
  const key = `${tenantId}:${userId}`;
  const hit = listLaneCache.get(key);
  if (hit) {
    const ttl = hit.verdict.degraded ? LIST_LANE_DEGRADED_TTL_MS : LIST_LANE_CACHE_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.verdict;
  }
  return listLaneFlight.run(key, async () => {
    const verdict = await computeListLaneMembership(tenantId, userId);
    if (listLaneCache.size >= LIST_LANE_CACHE_MAX_ENTRIES) listLaneCache.clear();
    listLaneCache.set(key, { at: Date.now(), verdict });
    return verdict;
  });
}
