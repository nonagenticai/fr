// The project form's type picker = the tenant's requirements_management project
// types (design: fr consumes RM vocabulary, George 2026-10-12). There is no
// frontend list: the old `projectTypes.ts` mirror is gone. The backend refuses a
// name its owning tenant does not define (422 `project_type_unknown`).
//
// v4 (George 2026-10-13): only a STARTABLE type is offered — one whose RM phase
// list starts with `setup` (the backend's `startable` flag; POST /api/projects
// answers 422 `project_type_not_startable` for the rest). v4 scope is the IT
// kinds; program / kaizen / meta / system_ops types are not offered.

import {
  catalogueNotInitialisedOf,
  listTenantProjectTypes,
  type CatalogueNotInitialisedInfo,
} from '$lib/api/conveyor-catalogue';

export interface ProjectTypeOption {
  value: string;
  label: string;
}

export type ProjectTypeOptions =
  | { kind: 'ready'; options: ProjectTypeOption[] }
  | { kind: 'not_initialised'; info: CatalogueNotInitialisedInfo }
  | { kind: 'failed'; message: string };

/** Load the picker. Never throws. */
export async function loadProjectTypeOptions(): Promise<ProjectTypeOptions> {
  const r = await listTenantProjectTypes();
  if (!r.ok) {
    const info = catalogueNotInitialisedOf(r.body);
    return info ? { kind: 'not_initialised', info } : { kind: 'failed', message: r.message };
  }
  if (!Array.isArray(r.data)) return { kind: 'failed', message: 'The project types could not be read' };
  return {
    kind: 'ready',
    options: r.data.filter((t) => t.startable === true).map((t) => ({ value: t.name, label: t.title || t.name })),
  };
}

/**
 * The options the select renders: a leading "Select…", the tenant's types, and
 * — when the form already holds a type the tenant does not define (a draft
 * carrying a legacy or invented name) — that value too, labelled as such, so
 * the select shows what is stored instead of silently blanking it.
 */
export function pickerOptions(state: ProjectTypeOptions | null, current: string): ProjectTypeOption[] {
  const loaded = state?.kind === 'ready' ? state.options : [];
  const out: ProjectTypeOption[] = [{ value: '', label: 'Select...' }, ...loaded];
  if (current && !loaded.some((o) => o.value === current)) {
    out.push({ value: current, label: `${current} (not a project type of this workspace)` });
  }
  return out;
}
