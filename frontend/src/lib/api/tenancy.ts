// src/lib/api/tenancy.ts
//
// Typed wrappers for the Plan-2 tenancy surface:
//
//   • Departments (admin):  /api/admin/departments[...]
//   • Department members:   /api/admin/departments/:id/members[...]
//   • Asset-scope mutations:/api/asset-scope/:asset_type/:asset_id/{promote,override,block}
//
// Built on `authFetch` so the bearer token is attached automatically. Wraps
// the endpoints by spec — the backend agent is racing this work on a
// separate worktree, so live 404s during integration are expected until the
// matching routes land. All tests mock `authFetch`, not a live backend.
//
// Plan reference: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md
// (Task 12).

import { authFetch } from './auth-fetch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Department = {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  default_landing: boolean;
  archived_at?: string | null;
};

export type DeptRole =
  | 'dept-admin'
  | 'dept-manager'
  | 'dept-member'
  | 'dept-viewer';

export type DepartmentMember = {
  user_id: string;
  role: DeptRole;
  joined_at: string;
  /**
   * Keycloak display fields, resolved server-side by
   * `routes/admin/department-members.ts`. Null when the id did not resolve —
   * that is a rendering instruction (degrade to a short id), never a name to
   * invent. `user_id` stays authoritative for every mutation.
   */
  name: string | null;
  email: string | null;
  /** True when Keycloak returned an account for `user_id`. */
  resolved: boolean;
};

export type DepartmentMemberList = {
  members: DepartmentMember[];
  /**
   * Non-null when the identity resolve threw outright. ⚠️ NOT a complete
   * outage detector — a plain Keycloak outage returns null here with every
   * row `resolved: false` (the backend's `resolveMemberIdentities` docblock
   * explains why). Callers must therefore treat "no row resolved at all" as
   * degraded too, rather than reporting every member as deleted.
   */
  directory_error: string | null;
};

export type AssetType =
  | 'requirement'
  | 'principle'
  | 'decision'
  | 'kag_document'
  | 'workflow'
  | 'trigger'
  | 'artifact'
  | 'channel';

export type DepartmentCreateInput = {
  name: string;
  description?: string;
};

export type DepartmentUpdatePatch = Partial<{
  name: string;
  description: string;
  default_landing: boolean;
}>;

export type PromoteTarget = 'workspace' | { dept_id: string };

export type ScopeSelector = {
  project_id?: string;
  dept_id?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ensureOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `${label} failed: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

// ---------------------------------------------------------------------------
// Departments — admin CRUD
// ---------------------------------------------------------------------------

/** GET /api/admin/departments */
export async function listDepartments(): Promise<Department[]> {
  const resp = await authFetch('/api/admin/departments');
  await ensureOk(resp, 'tenancy.listDepartments');
  // Backend wraps in a `{ data }` envelope (routes/admin/departments.ts).
  return ((await resp.json()) as { data: Department[] }).data ?? [];
}

/** GET /api/admin/departments/:id */
export async function getDepartment(id: string): Promise<Department> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(id)}`,
  );
  await ensureOk(resp, 'tenancy.getDepartment');
  return ((await resp.json()) as { data: Department }).data;
}

/** POST /api/admin/departments */
export async function createDepartment(
  input: DepartmentCreateInput,
): Promise<Department> {
  const resp = await authFetch('/api/admin/departments', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await ensureOk(resp, 'tenancy.createDepartment');
  return ((await resp.json()) as { data: Department }).data;
}

/** PATCH /api/admin/departments/:id */
export async function updateDepartment(
  id: string,
  patch: DepartmentUpdatePatch,
): Promise<Department> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    },
  );
  await ensureOk(resp, 'tenancy.updateDepartment');
  return ((await resp.json()) as { data: Department }).data;
}

/** POST /api/admin/departments/:id/archive */
export async function archiveDepartment(id: string): Promise<{ ok: true }> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(id)}/archive`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
    },
  );
  await ensureOk(resp, 'tenancy.archiveDepartment');
  return (await resp.json()) as { ok: true };
}

/**
 * Convenience: PATCH `default_landing` on a department. Wraps
 * `updateDepartment` to keep callsites declarative.
 */
export async function setDepartmentLanding(
  id: string,
  default_landing: boolean,
): Promise<Department> {
  return updateDepartment(id, { default_landing });
}

// ---------------------------------------------------------------------------
// Department members
// ---------------------------------------------------------------------------

/**
 * Normalise one wire row. Defensive because the identity fields are newer
 * than the endpoint: a backend that predates them yields `resolved: false`
 * + null names, i.e. exactly the degraded-but-readable render, rather than
 * `undefined` leaking into the template as the string "undefined".
 */
function toDepartmentMember(raw: unknown): DepartmentMember {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  return {
    user_id: String(r.user_id ?? ''),
    role: r.role as DeptRole,
    joined_at: String(r.joined_at ?? ''),
    name: str(r.name),
    email: str(r.email),
    resolved: r.resolved === true,
  };
}

/** GET /api/admin/departments/:id/members */
export async function listDepartmentMembers(
  deptId: string,
): Promise<DepartmentMemberList> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(deptId)}/members`,
  );
  await ensureOk(resp, 'tenancy.listDepartmentMembers');
  // Backend wraps in a `{ data }` envelope (routes/admin/department-members.ts).
  const body = (await resp.json()) as {
    data?: unknown;
    directory_error?: string | null;
  };
  return {
    members: (Array.isArray(body.data) ? body.data : []).map(toDepartmentMember),
    directory_error: body.directory_error ?? null,
  };
}

/** POST /api/admin/departments/:id/members */
export async function addDepartmentMember(
  deptId: string,
  input: { user_id: string; role: DeptRole },
): Promise<{ ok: true }> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(deptId)}/members`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
  );
  await ensureOk(resp, 'tenancy.addDepartmentMember');
  return (await resp.json()) as { ok: true };
}

/** PATCH /api/admin/departments/:id/members/:user_id */
export async function updateDepartmentMember(
  deptId: string,
  userId: string,
  patch: { role: DeptRole },
): Promise<{ ok: true }> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(deptId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    },
  );
  await ensureOk(resp, 'tenancy.updateDepartmentMember');
  return (await resp.json()) as { ok: true };
}

/** DELETE /api/admin/departments/:id/members/:user_id */
export async function removeDepartmentMember(
  deptId: string,
  userId: string,
): Promise<{ ok: true }> {
  const resp = await authFetch(
    `/api/admin/departments/${encodeURIComponent(deptId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  await ensureOk(resp, 'tenancy.removeDepartmentMember');
  // DELETE may return 204; tolerate both 204 and `{ ok: true }`.
  if (resp.status === 204) return { ok: true };
  return (await resp.json()) as { ok: true };
}

// ---------------------------------------------------------------------------
// Asset-scope mutations
// ---------------------------------------------------------------------------

/**
 * POST /api/asset-scope/:asset_type/:asset_id/promote
 *
 * Promotes the asset to a wider scope — either workspace-wide
 * (`'workspace'`) or up to a specific department (`{ dept_id }`).
 */
export async function promoteAsset(
  type: AssetType,
  id: string,
  to: PromoteTarget,
): Promise<unknown> {
  const resp = await authFetch(
    `/api/asset-scope/${encodeURIComponent(type)}/${encodeURIComponent(id)}/promote`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to }),
    },
  );
  await ensureOk(resp, 'tenancy.promoteAsset');
  return await resp.json();
}

/**
 * POST /api/asset-scope/:asset_type/:asset_id/override
 *
 * Records that — for the given scope (project_id or dept_id) — the
 * `candidate_asset_id` should override the asset addressed by the URL's
 * `asset_id` (the parent in the inheritance chain).
 */
export async function overrideAsset(
  type: AssetType,
  parentId: string,
  candidateId: string,
  scope: ScopeSelector,
): Promise<unknown> {
  const resp = await authFetch(
    `/api/asset-scope/${encodeURIComponent(type)}/${encodeURIComponent(parentId)}/override`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...scope, candidate_asset_id: candidateId }),
    },
  );
  await ensureOk(resp, 'tenancy.overrideAsset');
  return await resp.json();
}

/**
 * POST /api/asset-scope/:asset_type/:asset_id/block
 *
 * Blocks an inherited asset for the given scope (project or department),
 * preventing it from surfacing through the inheritance chain.
 */
export async function blockAsset(
  type: AssetType,
  id: string,
  scope: ScopeSelector,
): Promise<unknown> {
  const resp = await authFetch(
    `/api/asset-scope/${encodeURIComponent(type)}/${encodeURIComponent(id)}/block`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(scope),
    },
  );
  await ensureOk(resp, 'tenancy.blockAsset');
  return await resp.json();
}
