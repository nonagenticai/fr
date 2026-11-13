/**
 * fr-agui P1-TEAM-a — "is this user STILL homed in this tenant?", asked of
 * Keycloak, cheaply.
 *
 * Since P1-TEAM (George 2026-10-15) every member of a tenant acts on every
 * project of that tenant, so the tenant IS the access decision. Two places carry
 * a tenant that was derived EARLIER than the moment it is used:
 *   - an agent session (`agent_sessions.tenant_id`, frozen at issue; the
 *     refresh re-checks it, but a 15-minute access token outlives that check),
 *     re-checked here on EVERY agent-token request — invoke, every chat turn,
 *     every thread verb (`agentTenantRefusal`, lib/agent-read-identity.ts);
 *   - a channel principal (`capabilities/principal.ts`), derived from
 *     `user_roles` rows — a leftover row from before a re-homing would otherwise
 *     still grant tenant-wide reach.
 *
 * The answer is Keycloak's: the user's `tenant_id` attribute, else the user's own
 * id (exactly `deriveTenantId`'s reading of that user's token). A disabled or
 * deleted account is homed nowhere.
 *
 * ⛔ FAIL CLOSED. A Keycloak outage THROWS out of `userHomedIn` — never `true`.
 * Callers turn the throw into a retriable refusal (503) for a safety decision.
 *
 * ⏱️ CACHED for `HOME_TENANT_CACHE_TTL_MS` per user (answers only; an outage is
 * never cached), so a burst of turns or channel messages costs one admin-API
 * read. The TTL bounds how long a re-homing takes to bite: 15 s, against the
 * 15-minute access token and the 30-day refresh chain it closes.
 *
 * AUTH_BYPASS (never production: `validateProductionConfig` refuses to boot
 * with it): there is no directory, so the caller's tenant is taken as current —
 * the same rule as `resolveUserAccountStatus` (services/agent-session.ts).
 */

import { keycloak } from './keycloak';
import { hasSuperAdminRole } from '../lib/super-admin-gate';
import { isSuperAdminSwitchTarget } from '../lib/super-admin-switch-target';

const HOME_TENANT_CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 5_000;

interface UserHomeState {
  status: 'active' | 'disabled' | 'not_found';
  homeTenantId: string | null;
}

const lookup = (userId: string): Promise<UserHomeState> => keycloak.getUserAccountState(userId);

const cache = new Map<string, { at: number; state: UserHomeState }>();

/** The user's EFFECTIVE realm roles. THROWS when Keycloak cannot answer. */
const rolesLookup = (userId: string): Promise<string[]> => keycloak.getUserEffectiveRealmRoles(userId);
const rolesCache = new Map<string, { at: number; roles: string[] }>();

function bypassActive(): boolean {
  return (
    process.env.AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production'
  );
}

async function readState(userId: string): Promise<UserHomeState> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < HOME_TENANT_CACHE_TTL_MS) return hit.state;
  const state = await lookup(userId); // THROWS on an outage — nothing is cached.
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(userId, { at: Date.now(), state });
  return state;
}

/**
 * True iff `userId` is an ACTIVE Keycloak user whose home tenant is `tenantId`.
 * False for a re-homed, disabled or deleted user, and for an empty argument.
 * THROWS when Keycloak cannot answer (fail closed — the caller refuses).
 */
export async function userHomedIn(
  userId: string,
  tenantId: string | null | undefined,
): Promise<boolean> {
  if (!userId || typeof tenantId !== 'string' || tenantId.length === 0) return false;
  if (bypassActive()) return true;
  const state = await readState(userId);
  return state.status === 'active' && state.homeTenantId === tenantId;
}

async function readEffectiveRoles(userId: string): Promise<string[]> {
  const hit = rolesCache.get(userId);
  if (hit && Date.now() - hit.at < HOME_TENANT_CACHE_TTL_MS) return hit.roles;
  const roles = await rolesLookup(userId); // THROWS on an outage — nothing is cached.
  if (rolesCache.size >= CACHE_MAX_ENTRIES) rolesCache.clear();
  rolesCache.set(userId, { at: Date.now(), roles });
  return roles;
}

/**
 * The user's Keycloak HOME workspace from the raw `tenant_id` attribute — the
 * directory half of fr's member rule (`isTenantMemberForDecision`: a `user_roles`
 * row OR a Keycloak user homed in the tenant). Null for a disabled/deleted user, a
 * user with no attribute (the `sub` fallback is not a workspace), and under
 * AUTH_BYPASS (no directory). THROWS when Keycloak cannot answer (fail closed).
 */
export async function keycloakHomeWorkspace(userId: string): Promise<string | null> {
  if (!userId || bypassActive()) return null;
  const state = await readState(userId);
  if (state.status !== 'active' || !state.homeTenantId || state.homeTenantId === userId) return null;
  return state.homeTenantId;
}

/**
 * George 2026-10-27 ("I just need to be able to work as a tenant-admin in every
 * tenant I open"): the re-check for an agent session minted from a SUPER-ADMIN
 * WORKSPACE SWITCH (`X-Active-Tenant`, middleware/request-context.ts). Such a
 * session's tenant is deliberately NOT the user's home, so `userHomedIn` would
 * refuse it; it is worth exactly what the REST switch gate would still admit.
 *
 * True iff `userId` is an ACTIVE Keycloak user who STILL holds the
 * `super_admin` realm role (EFFECTIVE roles — composites included, i.e. what a
 * fresh token would carry) AND `tenantId` is STILL a switch target for them
 * (`isSuperAdminSwitchTarget`: a platform tenant, their own home, or — George
 * 2026-10-27 — any existing non-archived workspace) — the same predicate
 * `decideActiveTenantSwitch` applies to every REST request. A lookup failure
 * THROWS (fail closed).
 *
 * Freshness matches `userHomedIn`: both reads are cached `HOME_TENANT_CACHE_TTL_MS`
 * (15 s) per user, so a revoked role bites within 15 s on every agent call.
 *
 * ⛔ FAIL CLOSED. A Keycloak outage on either read THROWS — never `true`.
 * AUTH_BYPASS (never production): no directory, so the switch is taken as current,
 * exactly as `userHomedIn` takes the caller's tenant.
 */
export async function userMaySuperAdminSwitchInto(
  userId: string,
  tenantId: string | null | undefined,
): Promise<boolean> {
  if (!userId || typeof tenantId !== 'string' || tenantId.length === 0) return false;
  if (bypassActive()) return true;
  const state = await readState(userId);
  if (state.status !== 'active') return false;
  // session 'fr': a switch session can only have been issued through the REST
  // gate for an fr super-admin session (routes/agui-session.ts).
  if (!(await isSuperAdminSwitchTarget(tenantId, state.homeTenantId ?? undefined, { session: 'fr' }))) return false;
  return hasSuperAdminRole(await readEffectiveRoles(userId));
}
