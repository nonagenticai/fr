// src/routes/me/workspaces.ts
//
// GET /api/me/workspaces — list every workspace the calling user can act in.
//
// The three merged sources (real `user_roles` memberships + the super-admin
// switchable set + the caller's own JWT tenant), the first-source-wins dedup
// and the role-precedence rule all live in ONE place now:
// `lib/accessible-tenants.ts`. `/api/me/usage/by-tenant` and
// `/api/me/licenses/by-tenant` each used to keep their own copy, and both had
// drifted — see that file's header for the measured divergence. This handler
// keeps only what is specific to the switcher: the `kind` classification and
// the display sort.
//
// Used by the frontend top-bar workspace switcher (Plan
// in-fr-there-are-jazzy-pine §Frontend) to populate the dropdown and to
// pick the legal default if the localStorage-persisted active workspace is
// no longer accessible.
//
// Authorization: any authenticated user. Non-super-admins see only their
// `user_roles` workspaces (plus their own JWT tenant); the internal-tenant rows
// are hidden — the internal-tenant gates elsewhere still 404 anything they try.
//
// ⭐ George 2026-10-27: a super_admin is TENANT-ADMIN in every tenant it switches
// into, so a super_admin on an fr super-admin session is offered EVERY live
// workspace (with its name), each row EXCEPT the caller's own stamped
// `role: 'workspace-admin'` — exactly what the backend's admin gates answer once
// the switch is accepted (`isRealmTenantAdminOf`'s switch arm). The own row keeps
// the role the realm arm gives it (`workspace-admin` only when the token holds
// `tenant_admin` for that claim; otherwise `own_workspace`), because in home view
// the backend decides admin from the realm composite, not from a switch. The
// list is filtered by the X-Active-Tenant gate's own decision
// (`decideSwitchTarget`, inside `listPickerWorkspaces`), so the picker never
// offers a workspace the gate 403s,
// and the UI's tenant-admin navigation (which keys on this role) never shows a
// control the backend refuses.

import { validateAuth } from '../../middleware/auth';
import { INTERNAL_SYSTEM_TENANT_ID, KATA_TENANT_ID, isPlatformTenant } from '../../middleware/internal-tenant-only';
import {
  listPickerWorkspaces,
  OWN_WORKSPACE_ROLE,
  type AccessibleTenantSource,
} from '../../lib/accessible-tenants';
import { tryGetRequestContext } from '../../integrations/_lib/context';
import { jsonResponse } from '../../utils/response';

// Historical import path — the frontend's mirrored literal references it from here. Defined in
// `lib/accessible-tenants.ts`, which stamps it.
export { OWN_WORKSPACE_ROLE };

export type WorkspaceKind =
  | 'system'
  // The kata tenant (migration 228): every kata project.
  | 'kata'
  // The execution tenant and the two conveyor tenants (platform, non-internal).
  | 'execution'
  // George 2026-10-27: any non-platform workspace — a customer tenant. A
  // super-admin is offered every one of these, so they must not wear the
  // platform `execution` label.
  | 'customer';

export interface MyWorkspaceEntry {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /**
   * The user's explicit role in this workspace, or one of two synthetic
   * markers for rows that no `user_roles` row backs:
   *   - `'super_admin_scope'` — a platform tenant offered to a super-admin
   *     who is NOT on an fr super-admin session (e.g. a portal-issued
   *     super_admin): they may switch there to see its data but are not its
   *     tenant-admin. On an fr super-admin session every row except the
   *     caller's own is `'workspace-admin'` instead (see the file header).
   *   - `OWN_WORKSPACE_ROLE` (`'own_workspace'`) — the caller's own JWT
   *     tenant, surfaced because it is theirs. NOT a membership grant: the
   *     frontend's `tenantRoles` maps anything that is not
   *     `workspace-admin` / `admin` to `workspace-member`, and the backend
   *     gates on `user_roles` regardless, so this stamp confers nothing. It
   *     exists so the switcher can tell "mine" from "merely visible".
   */
  role: string;
  /**
   * Which enumeration source produced the row (`lib/accessible-tenants.ts`).
   * `'own_workspace'` marks the caller's own JWT tenant even when `role` was
   * raised to `'workspace-admin'` by the realm `tenant_admin` arm — the
   * switcher's default pick keys on this, not on `role`.
   */
  source: AccessibleTenantSource;
  archived_at: string | null;
}

function kindFor(workspaceId: string): WorkspaceKind {
  switch (workspaceId) {
    case INTERNAL_SYSTEM_TENANT_ID:
      return 'system';
    case KATA_TENANT_ID:
      return 'kata';
    default:
      return isPlatformTenant(workspaceId) ? 'execution' : 'customer';
  }
}

export async function handleListMyWorkspaces(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    const status =
      (e as { status?: number; statusCode?: number }).statusCode ??
      (e as { status?: number }).status ??
      401;
    return jsonResponse({ error: 'unauthorized' }, status);
  }

  // NOTE: this endpoint must ALWAYS return the full set of workspaces the
  // user can act in — it is the source of truth for the WorkspaceSwitcher
  // dropdown. A previous revision short-circuited to only the active tenant
  // when X-Active-Tenant was in play, which degraded the switcher to a
  // single non-clickable label (WorkspaceSwitcher renders a <span> when
  // length === 1). The active selection is conveyed via the header / the
  // workspaces store's `activeId`, never by filtering the list itself.

  // Sources 1-4 + dedup + role precedence + the super-admin picker rows: `lib/accessible-tenants.ts`.
  // This handler adds only the switcher-specific projection — `kind`, the
  // ISO-string `archived_at`, and the display sort below. The helper returns
  // rows in merge order (memberships → super-admin extras → own tenant) — the
  // exact order this handler used to build them in — and the sort below then
  // imposes the display order. `Array#sort` is stable, so merge order survives
  // only as the tie-break between two rows sharing both kind AND name, which is
  // what it was before the extraction too.
  // The gate's OWN answer about this session (buildRequestContext), never a
  // second derivation: the picker offers exactly what X-Active-Tenant admits.
  const all = await listPickerWorkspaces(
    user,
    tryGetRequestContext()?.callerIsFrSuperAdminSession === true ? 'fr' : 'untrusted_session',
  );
  const out: MyWorkspaceEntry[] = all.map((t) => ({
    id: t.id,
    name: t.name,
    kind: kindFor(t.id),
    role: t.role,
    source: t.source,
    archived_at: t.archived_at?.toISOString() ?? null,
  }));

  // Stable order: system → kata → execution → customer (alphabetical within a
  // kind). Mirrors switcher render order.
  const kindOrder: Record<WorkspaceKind, number> = {
    system: 0,
    kata: 1,
    execution: 2,
    customer: 3,
  };
  out.sort((a, b) => {
    const k = kindOrder[a.kind] - kindOrder[b.kind];
    if (k !== 0) return k;
    return a.name.localeCompare(b.name);
  });

  return jsonResponse({ workspaces: out });
}
