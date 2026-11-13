/**
 * fr-agui SPEC §6.5 — who acts, in which tenant, for a capability invoked from
 * the web agent or from a channel (Telegram / Teams).
 *
 * WEB. `POST /api/projects` admits any authenticated, non-service-account tenant
 * user and has NO tenant-role string check; `isAuthenticatedTenantUser` is that
 * same rule for the agent's catalog, so the capability invents none.
 *
 * CHANNEL. Building an `AuthUser` on a channel is a NEW identity derivation, so
 * its rules are narrow and fail closed:
 *   1. Principal — ONLY the dispatcher's `resolveIdentity` result (channel
 *      address → Keycloak user). An unlinked sender never reaches a capability.
 *   2. Tenant — derived from that user's tenant membership (`user_roles`), never
 *      from the message text or a header. More than one tenant ⇒ refused (fr has
 *      no channel-default-tenant setting yet, so there is nothing to pick from).
 *      P1-TEAM-a: the one membership must ALSO be the user's Keycloak home
 *      tenant (`tenant_id`), else refused — a leftover row is never reach.
 *   3. `AuthUser` — `{ id, tenantId, roles from the Keycloak admin lookup,
 *      isServiceAccount:false }`; the caller must still be a member of that tenant
 *      at the moment it acts (`channelAuthUser`), so a user removed between the
 *      park and the approve gets nothing.
 */

import { isAgentMemberId } from '../domain/engagement/agent-members';
import { and, eq } from 'drizzle-orm';

import { db } from '../db/client';
import { userRoles, workspaces } from '../db/schema';
import { keycloak } from '../services/keycloak';
import { isTenantMemberForDecision } from '../services/tenant-member-recipients';
import { keycloakHomeWorkspace, userHomedIn } from '../services/user-home-tenant';
import type { ActionContext } from '../agui/types';
import type { User } from '../types/api';
import { AppError } from '../utils/errors';

export interface ChannelTenant {
  id: string;
  name: string | null;
}

/** Every tenant the user holds a `user_roles` row in (distinct). */
export async function listUserTenants(userId: string): Promise<ChannelTenant[]> {
  const rows = await db
    .selectDistinct({ id: userRoles.tenant_id, name: workspaces.name })
    .from(userRoles)
    .leftJoin(workspaces, eq(workspaces.id, userRoles.tenant_id))
    .where(eq(userRoles.user_id, userId));
  return rows.map((r) => ({ id: r.id, name: r.name ?? null }));
}

async function workspaceName(tenantId: string): Promise<string | null> {
  const [row] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, tenantId)).limit(1);
  return row?.name ?? null;
}

/**
 * The workspaces a channel can act in for this user: every `user_roles` membership
 * plus the Keycloak home workspace (a realm-only member — e.g. a `tenant_admin`
 * granted in Keycloak with no `user_roles` row — is a member by fr's own rule,
 * `isTenantMemberForDecision`). THROWS when Keycloak cannot answer.
 */
export async function listChannelWorkspaces(userId: string): Promise<ChannelTenant[]> {
  const tenants = await listUserTenants(userId);
  const home = await keycloakHomeWorkspace(userId);
  if (home && !tenants.some((t) => t.id === home)) tenants.push({ id: home, name: await workspaceName(home) });
  return tenants;
}

/** Member of `tenantId` by fr's rule: a `user_roles` row, or homed there in Keycloak. */
export async function isChannelWorkspaceMember(userId: string, tenantId: string): Promise<boolean> {
  return (await isTenantMember(userId, tenantId)) || (await keycloakHomeWorkspace(userId)) === tenantId;
}

export async function isTenantMember(userId: string, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(and(eq(userRoles.user_id, userId), eq(userRoles.tenant_id, tenantId)))
    .limit(1);
  return rows.length > 0;
}

// The web rule for `projects.create` lives in the side-effect-free rbac-rules.ts
// (capability declarations reference it); re-exported here unchanged.
export { isAuthenticatedTenantUser } from './rbac-rules';

export type ChannelTenantResolution =
  | { kind: 'ok'; tenant: ChannelTenant }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number; tenants?: ChannelTenant[] }
  /**
   * P1-TEAM-a: exactly one `user_roles` membership, but it is NOT the user's
   * Keycloak home tenant (a leftover row from before a re-homing). Refused.
   */
  | { kind: 'mismatch' };

/**
 * Rule 2: the sender's tenant, from membership only — and (P1-TEAM-a) only when
 * that membership AGREES with the user's Keycloak `tenant_id`.
 *
 * ⛔ Since P1-TEAM every member of a tenant acts on every project of it, so the
 * derived tenant IS tenant-wide reach. A `user_roles` row is not removed when a
 * user is re-homed in Keycloak; before P1-TEAM such a leftover row granted
 * owner-only reach, now it would grant the whole old tenant. So the one
 * membership must be the Keycloak home tenant, else `mismatch` (refused). A
 * Keycloak outage THROWS (the dispatcher's retriable 503), never an `ok`.
 */
export async function resolveChannelTenant(
  userId: string,
  linkedTenantId?: string | null,
): Promise<ChannelTenantResolution> {
  if (!userId) return { kind: 'none' };
  let tenants = await listUserTenants(userId);
  // A realm-only member (no `user_roles` row in the workspace) is still a member by
  // fr's rule: their Keycloak home joins the list — only when needed, so a
  // `user_roles` member's resolution is unchanged and asks Keycloak no more.
  if (tenants.length === 0 || (linkedTenantId && !tenants.some((t) => t.id === linkedTenantId))) {
    tenants = await listChannelWorkspaces(userId);
  }
  if (tenants.length === 0) return { kind: 'none' };
  // A link pinned to a workspace (user_channel_prefs.tenant_id, migration 216) acts
  // in that one: it must still be a membership AND the Keycloak home tenant — the
  // same reach the web app gives the person, never more.
  if (linkedTenantId) {
    const linked = tenants.find((t) => t.id === linkedTenantId);
    // An agent member (fr #1683) has no Keycloak home: its admin-created link is
    // pinned to its one tenant, and its `user_roles` row is that membership.
    if (!linked || !(isAgentMemberId(userId) || (await userHomedIn(userId, linked.id)))) return { kind: 'mismatch' };
    return { kind: 'ok', tenant: linked };
  }
  if (tenants.length > 1) {
    // The per-workspace fan-out reads (`status.summary`) run once in each of
    // `tenants` — so only the memberships that agree with Keycloak are listed:
    // a leftover row from before a re-homing is never read through.
    const homed: ChannelTenant[] = [];
    for (const t of tenants) if (await userHomedIn(userId, t.id)) homed.push(t);
    return { kind: 'ambiguous', count: tenants.length, tenants: homed };
  }
  const tenant = tenants[0]!;
  if (!(isAgentMemberId(userId) || (await userHomedIn(userId, tenant.id)))) return { kind: 'mismatch' };
  return { kind: 'ok', tenant };
}

/**
 * The reply text for a sender whose tenant cannot be derived, on a command that
 * needs one (nothing is done). Actionable: it says what to do instead.
 */
export function channelTenantRefusalText(r: Exclude<ChannelTenantResolution, { kind: 'ok' }>): string {
  if (r.kind === 'mismatch') {
    return (
      'Nothing was done: your fr workspace membership does not match the workspace your account belongs to ' +
      '(it may have moved recently). Ask a workspace admin to update your membership.'
    );
  }
  return r.kind === 'none'
    ? 'Nothing was done: your account is not a member of any fr workspace, so there is nothing to act on. ' +
        'Ask a workspace admin to add you.'
    : `Nothing was done: you belong to ${r.count} fr workspaces and a channel command cannot tell which one ` +
        'you mean. Pick the workspace for this address on Communication settings in fr.';
}

const CHANNEL_SENDER_NOT_MEMBER = 'channel_sender_not_tenant_member';

/**
 * The code a channel refusal carries when the sender's tenant cannot be derived
 * unambiguously from membership (rule 2). The message is `channelTenantRefusalText`.
 */
const CHANNEL_TENANT_UNRESOLVED = 'channel_tenant_unresolved';

/**
 * Rule 2, defence in depth (layer 2). The channel dispatcher (layer 1) already
 * derives every channel invocation's tenant through `resolveChannelTenant` and
 * refuses `none` / `ambiguous` before anything runs. This re-derives it at the
 * write sites themselves (the park step and the `projects.create` handler), so a
 * future path that skips the dispatcher — or one that takes the tenant from
 * anywhere else (e.g. `getUserTenant`'s arbitrary `LIMIT 1` pick) — cannot park
 * or create in a tenant membership does not name uniquely.
 *
 * Refuses (403 `channel_tenant_unresolved`) unless the sender's tenant resolves —
 * exactly one membership, or the membership their link is pinned to
 * (`ctx.channelLinkedTenantId`) — and it is `ctx.tenantId`. Nothing is written by the refusal.
 */
export async function assertChannelTenantResolved(
  ctx: Pick<ActionContext, 'userId' | 'tenantId' | 'channelLinkedTenantId'>,
): Promise<void> {
  const r = await resolveChannelTenant(ctx.userId, ctx.channelLinkedTenantId);
  if (r.kind !== 'ok') {
    throw new AppError(403, channelTenantRefusalText(r)).withCode(CHANNEL_TENANT_UNRESOLVED);
  }
  if (!ctx.tenantId || r.tenant.id !== ctx.tenantId) {
    throw new AppError(
      403,
      'Nothing was created: this request names a workspace your fr membership does not resolve to.',
    ).withCode(CHANNEL_TENANT_UNRESOLVED);
  }
}

/**
 * Rule 3 + 5: the `AuthUser` a channel handler acts as. Refuses (403) a user who
 * is not — or is no longer — a member of `tenantId`.
 */
export async function channelAuthUser(userId: string, tenantId: string): Promise<User> {
  // fr #1683: an agent member has no Keycloak user; its membership is its `user_roles`
  // row in this tenant (it acts only in its own pinned tenant) and it holds no realm roles.
  if (isAgentMemberId(userId)) {
    if (!tenantId || !(await isTenantMember(userId, tenantId))) {
      throw new AppError(
        403,
        'Nothing was done: you are not a member of the workspace this request was made in.',
      ).withCode(CHANNEL_SENDER_NOT_MEMBER);
    }
    return { id: userId, email: '', name: '', roles: [], tenantId, isServiceAccount: false } as User;
  }
  // P1-TEAM-a: membership must still AGREE with the Keycloak home tenant at the
  // moment the user acts (a re-homed user's leftover row grants nothing). A
  // Keycloak outage throws — fail closed, nothing is done.
  if (
    !userId ||
    !tenantId ||
    !(await isChannelWorkspaceMember(userId, tenantId)) ||
    !(await userHomedIn(userId, tenantId))
  ) {
    throw new AppError(
      403,
      'Nothing was done: you are not a member of the workspace this request was made in.',
    ).withCode(CHANNEL_SENDER_NOT_MEMBER);
  }
  const roles = await keycloak.getUserRealmRoles(userId);
  return {
    id: userId,
    email: '',
    name: '',
    roles,
    tenantId,
    // Homed in `tenantId` (checked above) with a raw Keycloak `tenant_id` — exactly the
    // claim a web token carries, so the realm `tenant_admin` arm (isRealmTenantAdminOf)
    // applies on a channel as on the web. The `sub` fallback is never a claim.
    ...(tenantId !== userId ? { tenantClaim: tenantId } : {}),
    isServiceAccount: false,
  };
}

// ── P1-TEAM-c: the APPROVER as the acting principal of a parked action ─────────────────

const APPROVER_NOT_MEMBER = 'approver_not_tenant_member';

/**
 * fr-agui P1-TEAM-c (George 2026-10-15): "any member may approve, but the action then
 * runs under the APPROVER's identity, not the requester's". The principal a parked
 * action runs as when its approver is NOT its requester.
 *
 * Refuses (403 `approver_not_tenant_member`) unless, at the moment the action runs, the
 * approver is a CURRENT member of the approval's tenant (`isDecisionMember`: `user_roles`
 * ∪ a fresh Keycloak read — the same membership the decide arm admitted them by, so a
 * machine account is a full member) AND homed in it (`homedIn`, active + Keycloak
 * `tenant_id` = T). Any read failure refuses too (fail closed). There is NO fallback to
 * the requester: a refusal means nothing runs.
 *
 * ⭐ REALM `tenant_admin` APPROVERS (P1-TEAM-c audit). Measured in prod: 7 of 10 realm
 * tenant_admins hold NO `workspace-admin` `user_roles` row, so a principal admitted only
 * by that row refused them on every workspace-admin action. There is no token on this
 * deferred path, so the approver's Keycloak record is read FRESH through the admin client
 * (`approverDirectory`: their `tenant_id` attribute and EFFECTIVE realm roles — what a
 * token's `realm_access` and `tenant_id` claim would carry) and the attribute becomes
 * `tenantClaim`. `isWorkspaceAdminVia`'s realm arm then admits `tenant_admin` ONLY when
 * that home tenant IS the approval's tenant — a tenant_admin of another tenant gets
 * nothing here. Any read failure, or a disabled account, refuses (fail closed): nothing
 * runs, and never as anyone else. Super-admin: no special case (the realm roles carry it,
 * exactly as a token would).
 */
export async function approverActionPrincipal(userId: string, tenantId: string): Promise<User> {
  // fr #1683: an agent member has NO Keycloak user and no home tenant. Its membership is
  // its `user_roles` row in this tenant — the same membership the decide arm admitted it
  // by — so requiring a Keycloak home here would refuse every agent decision at
  // execution time (measured: `403 approver_not_tenant_member` after the decision
  // recorded, `getUserAccountState` 404 for the synthetic id). It acts with its
  // admin-assigned tenant role and no realm role, exactly as on a channel.
  if (isAgentMemberId(userId)) {
    if (tenantId && (await isTenantMemberForDecision(tenantId, userId))) {
      const [row] = await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(and(eq(userRoles.user_id, userId), eq(userRoles.tenant_id, tenantId)))
        .limit(1);
      return {
        id: userId,
        email: '',
        name: '',
        roles: row?.role ? [row.role] : [],
        tenantId,
        isServiceAccount: false,
      } as User;
    }
    throw new AppError(
      403,
      'Nothing was done: the approver is not (or can no longer be verified as) a member of the workspace ' +
        'this request was made in, and the action never runs as anyone else.',
    ).withCode(APPROVER_NOT_MEMBER);
  }

  let ok = false;
  let directory: { tenantId: string | null; effectiveRoles: string[]; enabled: boolean } | null = null;
  try {
    ok =
      Boolean(userId) &&
      Boolean(tenantId) &&
      (await isTenantMemberForDecision(tenantId, userId)) &&
      (await userHomedIn(userId, tenantId));
    if (ok) {
      directory = await keycloak.getUserTenantAndRoles(userId);
      ok = directory.enabled === true;
    }
  } catch {
    ok = false;
  }
  if (!ok || directory === null) {
    throw new AppError(
      403,
      'Nothing was done: the approver is not (or can no longer be verified as) a member of the workspace ' +
        'this request was made in, and the action never runs as anyone else.',
    ).withCode(APPROVER_NOT_MEMBER);
  }
  return {
    id: userId,
    email: '',
    name: '',
    roles: [...directory.effectiveRoles],
    tenantId,
    // The FRESH Keycloak home tenant, verbatim — never the approval's tenant. The realm
    // `tenant_admin` arm pins to it, so it admits only an admin OF this tenant.
    ...(directory.tenantId ? { tenantClaim: directory.tenantId } : {}),
    isServiceAccount: false,
  };
}
