// src/lib/api/admin-assets.ts
//
// Typed client for the super-admin asset console proxy
// (`/api/admin/assets/*`). v2 covers all five kinds: principles,
// requirements, decisions, workflows, projects.
//
// Authorization is implicit: `authFetch` already attaches the bearer
// token AND the X-Active-Tenant header from the workspace switcher store,
// so the route handler sees the correct active tenant.
//
// Per-kind notes:
//   - workflows: read-only (list + get only). n8n owns workflow editing.
//   - projects: no create (POST /api/projects owns provisioning).
//                Keyed by uuid id.
//
// Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend

import { authFetch } from './auth-fetch';

/**
 * Inheritance tag added by the backend's list/get endpoints. `true` when
 * the row originates from the system tenant — the UI renders it as a
 * read-only badge that says "SYSTEM" and disables edit/delete UI when the
 * caller's active workspace is NOT the system tenant.
 */
export interface InheritanceTag {
  is_system: boolean;
}

// All asset rows are typed loosely as Record + the inheritance tag. The
// upstream services own structural validation; the console UI only needs
// a permissive subset of each shape.
export type AdminPrinciple = Record<string, unknown> & InheritanceTag;
export type AdminRequirement = Record<string, unknown> & InheritanceTag;
export type AdminDecision = Record<string, unknown> & InheritanceTag;
export type AdminWorkflow = Record<string, unknown> & InheritanceTag;
export type AdminProject = Record<string, unknown> & InheritanceTag;

/** Union of every editable asset kind. Drives the drawer's `kind` prop. */
export type AdminAssetKind =
  | 'principles'
  | 'requirements'
  | 'decisions'
  | 'workflows'
  | 'projects';

async function jsonOrThrow<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    throw Object.assign(new Error(`admin-assets ${ctx} ${res.status}`), {
      status: res.status,
      body,
    });
  }
  return (await res.json()) as T;
}

async function throwIfNotOk(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  throw Object.assign(new Error(`admin-assets ${ctx} ${res.status}`), {
    status: res.status,
    body,
  });
}

// ---------------------------------------------------------------------------
// principles
// ---------------------------------------------------------------------------

export async function listAdminPrinciples(): Promise<AdminPrinciple[]> {
  const res = await authFetch('/api/admin/assets/principles');
  const body = await jsonOrThrow<{ principles: AdminPrinciple[] }>(res, 'listPrinciples');
  return body.principles;
}

export async function getAdminPrinciple(id: string): Promise<AdminPrinciple> {
  const res = await authFetch(`/api/admin/assets/principles/${encodeURIComponent(id)}`);
  const body = await jsonOrThrow<{ principle: AdminPrinciple }>(res, 'getPrinciple');
  return body.principle;
}

export async function createAdminPrinciple(
  payload: Record<string, unknown>,
): Promise<AdminPrinciple> {
  const res = await authFetch('/api/admin/assets/principles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ principle: AdminPrinciple }>(res, 'createPrinciple');
  return body.principle;
}

export async function updateAdminPrinciple(
  id: string,
  payload: Record<string, unknown>,
): Promise<AdminPrinciple> {
  const res = await authFetch(`/api/admin/assets/principles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ principle: AdminPrinciple }>(res, 'updatePrinciple');
  return body.principle;
}

export async function deleteAdminPrinciple(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/assets/principles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await throwIfNotOk(res, 'deletePrinciple');
}

// ---------------------------------------------------------------------------
// requirements
// ---------------------------------------------------------------------------

export async function listAdminRequirements(): Promise<AdminRequirement[]> {
  const res = await authFetch('/api/admin/assets/requirements');
  const body = await jsonOrThrow<{ requirements: AdminRequirement[] }>(res, 'listRequirements');
  return body.requirements;
}

export async function getAdminRequirement(id: string): Promise<AdminRequirement> {
  const res = await authFetch(`/api/admin/assets/requirements/${encodeURIComponent(id)}`);
  const body = await jsonOrThrow<{ requirement: AdminRequirement }>(res, 'getRequirement');
  return body.requirement;
}

export async function createAdminRequirement(
  payload: Record<string, unknown>,
): Promise<AdminRequirement> {
  const res = await authFetch('/api/admin/assets/requirements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ requirement: AdminRequirement }>(res, 'createRequirement');
  return body.requirement;
}

export async function updateAdminRequirement(
  id: string,
  payload: Record<string, unknown>,
): Promise<AdminRequirement> {
  const res = await authFetch(`/api/admin/assets/requirements/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ requirement: AdminRequirement }>(res, 'updateRequirement');
  return body.requirement;
}

export async function deleteAdminRequirement(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/assets/requirements/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await throwIfNotOk(res, 'deleteRequirement');
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

export async function listAdminDecisions(): Promise<AdminDecision[]> {
  const res = await authFetch('/api/admin/assets/decisions');
  const body = await jsonOrThrow<{ decisions: AdminDecision[] }>(res, 'listDecisions');
  return body.decisions;
}

export async function getAdminDecision(id: string): Promise<AdminDecision> {
  const res = await authFetch(`/api/admin/assets/decisions/${encodeURIComponent(id)}`);
  const body = await jsonOrThrow<{ decision: AdminDecision }>(res, 'getDecision');
  return body.decision;
}

export async function createAdminDecision(
  payload: Record<string, unknown>,
): Promise<AdminDecision> {
  const res = await authFetch('/api/admin/assets/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ decision: AdminDecision }>(res, 'createDecision');
  return body.decision;
}

export async function updateAdminDecision(
  id: string,
  payload: Record<string, unknown>,
): Promise<AdminDecision> {
  const res = await authFetch(`/api/admin/assets/decisions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ decision: AdminDecision }>(res, 'updateDecision');
  return body.decision;
}

export async function deleteAdminDecision(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/assets/decisions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await throwIfNotOk(res, 'deleteDecision');
}

// ---------------------------------------------------------------------------
// workflows — read-only; n8n owns edit
// ---------------------------------------------------------------------------

export async function listAdminWorkflows(opts?: {
  active?: boolean;
  limit?: number;
}): Promise<AdminWorkflow[]> {
  const qs = new URLSearchParams();
  if (opts?.active !== undefined) qs.set('active', String(opts.active));
  if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await authFetch(`/api/admin/assets/workflows${suffix}`);
  const body = await jsonOrThrow<{ workflows: AdminWorkflow[] }>(res, 'listWorkflows');
  return body.workflows;
}

export async function getAdminWorkflow(id: string): Promise<AdminWorkflow> {
  const res = await authFetch(`/api/admin/assets/workflows/${encodeURIComponent(id)}`);
  const body = await jsonOrThrow<{ workflow: AdminWorkflow }>(res, 'getWorkflow');
  return body.workflow;
}

// ---------------------------------------------------------------------------
// projects — no create here (POST /api/projects owns provisioning)
// ---------------------------------------------------------------------------

export async function listAdminProjects(): Promise<AdminProject[]> {
  const res = await authFetch('/api/admin/assets/projects');
  const body = await jsonOrThrow<{ projects: AdminProject[] }>(res, 'listProjects');
  return body.projects;
}

export async function getAdminProject(id: string): Promise<AdminProject> {
  const res = await authFetch(`/api/admin/assets/projects/${encodeURIComponent(id)}`);
  const body = await jsonOrThrow<{ project: AdminProject }>(res, 'getProject');
  return body.project;
}

export async function updateAdminProject(
  id: string,
  // NO 'archived' here. Archiving carries the HIPAA right-to-delete obligation to
  // purge every one of the project's documents' downstream PHI first, so it goes
  // through DELETE /api/admin/assets/projects/:id (deleteAdminProject below).
  // The PATCH endpoint rejects status='archived' with 400 `archive_via_delete`;
  // keeping it in this type would let callers compile a request the API refuses.
  // NO name / description either: both are requirements_management's after the
  // project request (v4 ruling 1); the endpoint answers 422 `rm_owned_field`.
  payload: { status?: 'submitted' | 'active' },
): Promise<AdminProject> {
  const res = await authFetch(`/api/admin/assets/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ project: AdminProject }>(res, 'updateProject');
  return body.project;
}

export async function deleteAdminProject(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/assets/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await throwIfNotOk(res, 'deleteProject');
}
