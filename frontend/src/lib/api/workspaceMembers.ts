// lib/api/workspaceMembers.ts
//
// Client for the tenant-admin members API (backend routes/workspace/members.ts).
//
// ⛔ There is deliberately NO tenant parameter anywhere in this module. The
// backend reads the tenant from the request context, and adding one here would
// be the first half of a cross-tenant escalation: the field would be accepted
// by this client, rejected by the server's `.strict()` schema today, and become
// live the day someone "wires it up". If you find yourself wanting to pass a
// tenant, you want the SUPER-ADMIN api (`/api/admin/users`) instead.
import { authFetch } from './auth-fetch';

/** The two roles a workspace admin may grant. Mirrors the server enum. */
export type WorkspaceRole = 'workspace-admin' | 'workspace-member';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = [
  'workspace-admin',
  'workspace-member',
] as const;

export interface WorkspaceMemberGrant {
  tenant_id: string;
  tenant_name: string | null;
  role: string;
  /** Null for an entry synthesised from the realm `tenant_admin` role: no grant row, no grant time. */
  granted_at: string | null;
  granted_by: string | null;
  /** 'keycloak' on an entry synthesised from realm `tenant_admin`; absent for DB rows. */
  source?: 'keycloak';
}

/**
 * Where a member's workspace-admin status comes from (fr#1289). Present only on
 * admins. 'keycloak' / 'both' mean the admin role is held via the realm
 * `tenant_admin` role. It can be removed through this API only when the list
 * says `realm_admin_revocable: true`; otherwise the revoke returns 409
 * `realm_tenant_admin_not_revocable_here`.
 */
export type AdminSource = 'db' | 'keycloak' | 'both';

export interface WorkspaceMember {
  user_id: string;
  /** Null when Keycloak could not resolve the id — see `resolved`. */
  email: string | null;
  name: string | null;
  /**
   * False when the directory lookup did not return this id. The row is still
   * listed: an unresolvable grant is a DANGLING one (deleted account), and
   * hiding it would hide real access.
   */
  resolved: boolean;
  workspaces: WorkspaceMemberGrant[];
  admin_source?: AdminSource;
}

export interface WorkspaceMemberList {
  members: WorkspaceMember[];
  tenant_id: string;
  /**
   * Non-null when identity resolution threw outright — names unavailable,
   * grants intact. ⚠️ NOT the same as a row with `resolved: false`: that is one
   * dangling grant, this is "the directory is down". Rendering them the same
   * way tells an operator that everyone was deleted.
   */
  directory_error: string | null;
  /**
   * True when the Keycloak realm-admin lookup failed: `members` is then the
   * `user_roles` view only and may be MISSING realm-only admins.
   */
  realm_admins_unavailable: boolean;
  /**
   * True when fr can write the realm `tenant_admin` role (fr#1289 part B,
   * write-through enabled), so admin rows with `admin_source` 'keycloak' /
   * 'both' become manageable here. Absent (older backend) reads as FALSE:
   * enabling a control the server will refuse is worse than a locked one.
   */
  realm_admin_revocable: boolean;
  /**
   * P1-TEAM-b (George 2026-10-15): members every approval/question/notification now
   * goes to, but whom fr cannot PUSH to — `passive_only` (only in-app / live channels
   * enabled) or `unknown` (no channels configured at all). Absent (older backend) reads
   * as an empty list.
   */
  unreachable_members: UnreachableMember[];
  /** The Keycloak half of the member list could not be read: the list may be incomplete. */
  unreachable_members_partial: boolean;
}

export interface UnreachableMember {
  user_id: string;
  name: string | null;
  email: string | null;
  verdict: 'passive_only' | 'unknown';
}

/**
 * Outcome of the Keycloak write-through a grant/revoke triggered (fr#1289).
 * Free-form on purpose: the backend owns the vocabulary; the UI reacts only to
 * 'failed'. Null when the response carried none (older backend / no-op).
 */
export type KeycloakSyncOutcome = string;

export interface WorkspaceRoleChangeResult {
  keycloak_sync: KeycloakSyncOutcome | null;
}

/**
 * Readable text for the backend's machine error codes. The raw body is still
 * appended by `ensureOk` for anything not listed here.
 */
export const WORKSPACE_MEMBER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  realm_tenant_admin_not_revocable_here:
    "This person is an administrator through your organisation's identity provider (tenant_admin). That role must be removed there, not here.",
  admin_count_unavailable:
    'Could not verify the administrators from the identity provider, so the change was refused. Try again shortly.',
  keycloak_write_failed:
    'The identity provider could not be updated, so nothing was changed. Try again shortly.',
  'cannot remove the last workspace admin':
    'This would leave the workspace with no administrator. Make someone else an administrator first.',
  super_admin_implies_tenant_admin:
    'This person is a platform super-admin, which always includes administrator rights here. Their admin role cannot be removed in this workspace.',
};

/** Read `keycloak_sync` off a 2xx body without trusting its shape. */
async function readSync(resp: Response): Promise<WorkspaceRoleChangeResult> {
  let body: unknown = null;
  try {
    const text = await resp.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    /* empty or non-JSON success body — no sync outcome */
  }
  const v =
    body && typeof body === 'object' ? (body as { keycloak_sync?: unknown }).keycloak_sync : undefined;
  return { keycloak_sync: typeof v === 'string' ? v : null };
}

async function ensureOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    let code: unknown;
    try {
      code = (JSON.parse(detail) as { error?: unknown }).error;
    } catch {
      /* not JSON — fall through to the raw form */
    }
    if (typeof code === 'string' && code in WORKSPACE_MEMBER_ERROR_MESSAGES) {
      throw new Error(WORKSPACE_MEMBER_ERROR_MESSAGES[code]);
    }
    throw new Error(
      `${label} failed: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

/** GET /api/workspace/members */
export async function listWorkspaceMembers(): Promise<WorkspaceMemberList> {
  const resp = await authFetch('/api/workspace/members');
  await ensureOk(resp, 'workspaceMembers.list');
  const body = (await resp.json()) as Partial<WorkspaceMemberList>;
  return {
    members: body.members ?? [],
    tenant_id: body.tenant_id ?? '',
    directory_error: body.directory_error ?? null,
    // Absent (older backend) reads as "not unavailable"; the per-member
    // `admin_source` passes through untouched inside `members`.
    realm_admins_unavailable: body.realm_admins_unavailable === true,
    realm_admin_revocable: body.realm_admin_revocable === true,
    unreachable_members: Array.isArray(body.unreachable_members) ? body.unreachable_members : [],
    unreachable_members_partial: body.unreachable_members_partial === true,
  };
}

/** POST /api/workspace/members/:userId/roles */
export async function grantWorkspaceRole(
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceRoleChangeResult> {
  const resp = await authFetch(
    `/api/workspace/members/${encodeURIComponent(userId)}/roles`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    },
  );
  await ensureOk(resp, 'workspaceMembers.grant');
  return readSync(resp);
}

/**
 * DELETE /api/workspace/members/:userId/roles?role=...
 *
 * The role rides in the query string because DELETE-with-body does not survive
 * every proxy between cloudflared and the pod.
 */
export async function revokeWorkspaceRole(
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceRoleChangeResult> {
  const resp = await authFetch(
    `/api/workspace/members/${encodeURIComponent(userId)}/roles?role=${encodeURIComponent(role)}`,
    { method: 'DELETE' },
  );
  await ensureOk(resp, 'workspaceMembers.revoke');
  return readSync(resp);
}
