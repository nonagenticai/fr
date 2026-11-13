// src/lib/super-admin-switch-target.ts
//
// ⭐ George 2026-10-27 (memory george-2026-10-27-super-admin-is-tenant-admin-
// everywhere): a `super_admin` operates as TENANT-ADMIN in ANY tenant it switches
// into — the same model as commonpractice, care-bus, agent and Studio — and every
// such action is audited.
//
// THE ONE ANSWER to "may a super_admin switch into tenant T?". Shared by the
// X-Active-Tenant gate (middleware/request-context.ts), the kanban WebSocket
// upgrade (routes/kanbanWsAuth.ts), the agent-session refresh/re-check
// (services/agent-session.ts, services/user-home-tenant.ts) and the workspace
// picker (lib/accessible-tenants.ts `listPickerWorkspaces`), so a tenant the
// picker offers is exactly a tenant the gate admits — never a chip that 403s.
//
//   * a PLATFORM tenant (`isPlatformTenant`) or the caller's OWN JWT tenant —
//     admitted without a lookup (unchanged since fr row 14d);
//   * any other tenant iff fr holds a `workspaces` row for it with
//     `archived_at IS NULL` (an existing, live customer workspace) AND the
//     token is an FR SUPER-ADMIN SESSION (lib/super-admin-session-trust.ts:
//     a human, signed by the fr realm issuer, minted for fr's browser client);
//   * an archived workspace → refused, reason `archived`;
//   * no `workspaces` row → refused, reason `unknown`;
//   * a service account naming a customer workspace → reason `service_account`;
//   * any other super_admin token (another realm — e.g. a portal-issued bot via
//     portal-bff — or another client) → reason `untrusted_session`.
//
// It decides only the SWITCH. Everything a switched super_admin may then do is
// tenant-admin (`isRealmTenantAdminOf`, services/user-roles.ts) — and that arm
// too is honoured only for an fr super-admin session. The fr package licence
// gate (`requireFrLicense`, server.ts) still applies to the switched tenant
// exactly as it does to that tenant's own admins.
//
// This module never widens anything for a NON-super_admin: every caller applies
// it only after the SIGNED `super_admin` realm role has been established, and a
// non-super_admin's X-Active-Tenant is still ignored by request-context.ts.

import { eq } from 'drizzle-orm';
import { db, workspaces } from '../db/client';
import { isPlatformTenant } from '../middleware/internal-tenant-only';
import type { SuperAdminSessionTrust } from './super-admin-session-trust';

// The ONE session classifier (REST gate + WS upgrade) lives in
// lib/super-admin-session-trust.ts; re-exported for the callers that import it here.
export { superAdminSessionTrustFromClaims, type SuperAdminSessionTrust } from './super-admin-session-trust';

export type SwitchRefusalReason = 'archived' | 'unknown' | 'service_account' | 'untrusted_session';

export type SwitchTargetDecision =
  | { ok: true; kind: 'platform' | 'own' | 'workspace' }
  | { ok: false; reason: SwitchRefusalReason };

/** What the decision needs to know about the tenant's `workspaces` row. */
export interface SwitchTargetRow {
  archived_at: Date | string | null;
}

/** Fast path: platform / own tenant need no row and no session trust. */
function decideWithoutRow(tenantId: string, homeTenantId: string | null | undefined): SwitchTargetDecision | null {
  if (isPlatformTenant(tenantId)) return { ok: true, kind: 'platform' };
  if (typeof homeTenantId === 'string' && tenantId === homeTenantId) return { ok: true, kind: 'own' };
  return null;
}

/**
 * Pure: decide from an already-loaded row (`null` = no row). The picker uses
 * this over the rows it has already selected; the async form below loads one.
 */
export function decideSwitchTarget(
  tenantId: string,
  homeTenantId: string | null | undefined,
  row: SwitchTargetRow | null,
  caller: { session: SuperAdminSessionTrust },
): SwitchTargetDecision {
  const fast = decideWithoutRow(tenantId, homeTenantId);
  if (fast) return fast;
  if (caller.session !== 'fr') return { ok: false, reason: caller.session };
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.archived_at !== null && row.archived_at !== undefined) return { ok: false, reason: 'archived' };
  return { ok: true, kind: 'workspace' };
}

async function lookup(tenantId: string): Promise<SwitchTargetRow | null> {
  const [row] = await db
    .select({ archived_at: workspaces.archived_at })
    .from(workspaces)
    .where(eq(workspaces.id, tenantId))
    .limit(1);
  return row ?? null;
}

/**
 * Decide whether a super_admin may switch into `tenantId`. Platform / own
 * tenants cost no query; an untrusted session costs none either; any other
 * tenant costs one primary-key lookup. A lookup failure THROWS (the caller
 * fails closed — 503 at the REST gate).
 */
export async function superAdminSwitchTarget(
  tenantId: string,
  homeTenantId: string | null | undefined,
  caller: { session: SuperAdminSessionTrust },
): Promise<SwitchTargetDecision> {
  const fast = decideWithoutRow(tenantId, homeTenantId);
  if (fast) return fast;
  if (caller.session !== 'fr') return { ok: false, reason: caller.session };
  return decideSwitchTarget(tenantId, homeTenantId, await lookup(tenantId), caller);
}

/** Boolean form for callers that need only yes/no. Throws on lookup failure. */
export async function isSuperAdminSwitchTarget(
  tenantId: string,
  homeTenantId: string | null | undefined,
  caller: { session: SuperAdminSessionTrust },
): Promise<boolean> {
  return (await superAdminSwitchTarget(tenantId, homeTenantId, caller)).ok;
}
