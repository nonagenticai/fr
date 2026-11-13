/**
 * fr-agui SPEC §5.7 rule 3 — capability inputs never carry the project.
 *
 * When the agent runs in a project-bound thread (`ctx.projectId` set from
 * `agent_runtime_sessions.project_id`, routes/agent.ts), the project comes from
 * the THREAD, never from the model:
 *
 *   - INJECTION. A `tenancy:'project'` capability's project parameter
 *     (`action.projectParam`, derived from its `/api/projects/:<param>` path by
 *     capabilities/derive-agent.ts) is removed from the LLM-facing schema
 *     (agent/tool-catalog.ts) and set to `ctx.projectId` here.
 *   - MISMATCH. Any project id the model DID put in the input — the project
 *     parameter itself, or ANY project-naming key anywhere in the input
 *     (`isProjectKey`, P1c) — must equal the bound project, or the call is
 *     refused 403 `project_mismatch` before validation, RBAC, idempotency or
 *     any handler. An input too deep to scan is refused (422 `input_too_deep`).
 *
 * Outside a bound thread (`ctx.projectId` null — the tenant-level doorway) the
 * input is returned unchanged: the doorway reads (`projects.get`) take the id
 * the user asked about, and their handlers apply the project READ gate.
 *
 * Applied at BOTH dispatch seams — the agent loop's `runOneTool` (before a
 * proposal is shaped or an action invoked) and `invokeAction` (every other
 * caller) — and idempotent, so the second application is a no-op.
 */
import { AppError } from '../utils/errors';

export const PROJECT_MISMATCH = 'project_mismatch';

export class ProjectMismatchError extends AppError {
  constructor(actionName: string, field: string, bound: string) {
    super(
      403,
      `${PROJECT_MISMATCH}: ${actionName} named another project in "${field}"; ` +
        `this conversation is bound to project ${bound} and can act on that project only`,
      { field, bound_project_id: bound },
    );
    this.name = 'ProjectMismatchError';
    this.code = PROJECT_MISMATCH;
  }
}

/**
 * P1c (carried from the P1b audit, MAJOR): which input KEYS name a project.
 *
 * P1b matched only the exact keys `projectId` / `project_id` and stopped below
 * depth 6, so `kanban.create_card {project_ref:"<B>"}` and `bridge.edit_draft
 * {patch:{target_project_id:B}}` reached another project from a thread bound to
 * A. Now, case-insensitively:
 *   - any key ENDING in `project_id` / `projectid` / `project_ref` / `projectref`
 *     (so `target_project_id`, `targetProjectId`, `parentProjectRef`, …), with an
 *     optional plural `s` (an array: every element must be the bound project);
 *   - the fr asset-binding filters `bound_to` / `visible_in` (their value is a
 *     project id, agui/actions/{requirements,decisions,principles}.ts);
 *   - a key named exactly `project` (a string id, or an object whose `id` is).
 * A value that is not the bound project — including a non-string — is refused.
 * Over-matching only refuses a call in a BOUND thread; it never admits one.
 */
const PROJECT_KEY_RE = /(project_?id|project_?ref)s?$/i;
const PROJECT_FILTER_KEYS: ReadonlySet<string> = new Set(['bound_to', 'visible_in']);

export function isProjectKey(key: string): boolean {
  return PROJECT_KEY_RE.test(key) || PROJECT_FILTER_KEYS.has(key.toLowerCase()) || key.toLowerCase() === 'project';
}

/** Kept for existing importers: the two canonical keys (both match `isProjectKey`). */
export const PROJECT_ID_KEYS: ReadonlyArray<string> = ['projectId', 'project_id'];

/**
 * The scan has NO depth cut-off that admits: an input nested deeper than this is
 * REFUSED (fail closed), never skipped. Real inputs are flat or shallow.
 */
export const MAX_SCAN_DEPTH = 32;

export class ProjectInputTooDeepError extends AppError {
  constructor(actionName: string) {
    super(422, `${actionName}: the input is nested too deeply to verify which project it names`);
    this.name = 'ProjectInputTooDeepError';
    this.code = 'input_too_deep';
  }
}

function sameId(a: unknown, bound: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === bound.toLowerCase();
}

function blank(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/** The offending path under a project key, or null when `v` names only the bound project. */
function projectValueOffends(key: string, v: unknown, bound: string, path: string): string | null {
  if (blank(v)) return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      if (!blank(v[i]) && !sameId(v[i], bound)) return `${path}[${i}]`;
    }
    return null;
  }
  if (key.toLowerCase() === 'project' && typeof v === 'object') {
    const id = (v as Record<string, unknown>).id;
    return blank(id) || sameId(id, bound) ? null : `${path}.id`;
  }
  return sameId(v, bound) ? null : path;
}

function scan(actionName: string, value: unknown, bound: string, path: string, depth: number): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_SCAN_DEPTH) throw new ProjectInputTooDeepError(actionName);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = scan(actionName, value[i], bound, `${path}[${i}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (isProjectKey(k)) {
      const off = projectValueOffends(k, v, bound, here);
      if (off !== null) return off;
    }
    const hit = scan(actionName, v, bound, here, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

export interface ProjectBindable {
  name: string;
  /** The input key that names the project (derived; absent for non-project actions). */
  projectParam?: string;
}

/**
 * The input to dispatch for `action` under `ctx`. Throws `ProjectMismatchError`
 * when the input names a project other than the bound one.
 */
export function bindProjectInput(
  action: ProjectBindable,
  input: unknown,
  ctx: { projectId: string | null },
): unknown {
  const bound = ctx.projectId;
  if (!bound) return input;
  const base =
    input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  // The project parameter is checked at the TOP level only: it is a path
  // parameter, and a generic name like `id` may legitimately appear nested.
  const param = action.projectParam;
  if (param && base !== null) {
    const v = base[param];
    if (v !== undefined && v !== null && v !== '' && !sameId(v, bound)) {
      throw new ProjectMismatchError(action.name, param, bound);
    }
  }
  const offending = scan(action.name, input, bound, '', 0);
  if (offending !== null) throw new ProjectMismatchError(action.name, offending, bound);
  if (!param) return input;
  return { ...(base ?? {}), [param]: bound };
}

/**
 * The LLM-facing JSON Schema with the project parameter (and any further
 * project-naming keys the binding hides) removed — bound threads only.
 */
export function stripProjectParam(
  schema: Record<string, unknown> | null,
  projectParam: string | undefined,
  hide: readonly string[] = [],
): Record<string, unknown> | null {
  const drop = new Set([...(projectParam ? [projectParam] : []), ...hide]);
  if (schema === null || drop.size === 0) return schema;
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || ![...drop].some((k) => k in props)) return schema;
  const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !drop.has(k)));
  const out: Record<string, unknown> = { ...schema, properties: rest };
  if (Array.isArray(schema.required)) {
    const required = (schema.required as unknown[]).filter((r) => typeof r !== 'string' || !drop.has(r));
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}
