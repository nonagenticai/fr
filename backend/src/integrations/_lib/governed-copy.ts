/**
 * G8 / R313 — the wire shapes fr sends requirements_management for a governed asset's
 * project copy and its promotion (RM#230; routers/_governed.py on RM main).
 *
 *   POST /{kind}/{id}/project-copy   { project_id, changes }   — idempotent per (id, project)
 *   POST /{kind}/{copy_id}/promote   { approved_by? }          — fr-delegated only
 *   PUT/PATCH/DELETE ?scope_project_id=<project>             — the project the write is FOR;
 *       RM answers 409 `inherited_asset_requires_copy` when that project does not own the row.
 *
 * The generated `@fr/service-client-requirements` predates these routes, so the URLs are
 * built from the generated item URL here (one place, three kinds).
 */
export interface ProjectCopyBody {
  project_id: string;
  changes: Record<string, unknown>;
}

export interface PromoteBody {
  approved_by?: string;
}

/** Append `scope_project_id` to an RM item URL (absent ⇒ the URL unchanged: a tenant-level edit). */
export function withScopeProject(url: string, scopeProjectId: string | undefined): string {
  if (!scopeProjectId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}scope_project_id=${encodeURIComponent(scopeProjectId)}`;
}
