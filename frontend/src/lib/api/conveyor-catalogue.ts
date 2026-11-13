// /api/conveyor/catalogue/* — the tenant PM catalogue in requirements_management
// (RM), proxied by backend/src/routes/conveyor-catalogue.ts. It holds project
// phases, conveyor capabilities, card types, project types and gates
// (Tier 1), WIP limits, priority levels, deliverable kinds, milestone kinds and
// board templates (Tier 2), plus the project-type matrix and the
// import-defaults bootstrap.
//
// ⛔ fr is a FACILITATOR here. This module SENDS what the form holds and hands
// back what RM answered. It never checks a name or a phase order. An
// RM refusal (4xx, typically a 422) comes back as a `CatalogueFailure` carrying
// the status and the parsed error body, and the page renders that next to the
// form unchanged.
//
// Reads are open to every member of the tenant. Writes and import are
// tenant_admin only: the backend answers `403 {error:'tenant_admin_required'}`,
// and that 403 is rendered like any other refusal.
//
// NULL vs empty (RM rm#208): `null` = NOT SET (import-defaults fills it), while
// `[]` / `""` = deliberately CLEARED (they stay cleared). GET returns the NULLs,
// so the nullable fields below are typed `| null` and the UI renders null as
// "not set". RM's catalogue PUT is PARTIAL: an omitted key is left unchanged
// and an explicit null sets NULL — so an edit sends only the keys it changed
// (`changedFields` in $lib/conveyor-catalogue/forms) and never turns an
// untouched null into `[]`.

import type { PriorityLevel as TenantPriorityLevel } from '$lib/priority/priority';
import { authFetch } from './auth-fetch';
import { formatApiError } from './api-error';

/** The resources the backend allowlists (`PM_CATALOGUE_RESOURCES`). */
export type CatalogueResource =
  | 'project-phases'
  | 'capabilities'
  | 'card-types'
  | 'project-types'
  | 'gates'
  | 'wip-limits'
  | 'priority-levels'
  | 'deliverable-kinds'
  | 'milestone-kinds'
  | 'board-templates';

export interface CatalogueBase {
  id: string;
  name: string;
  title: string;
  description?: string | null;
  tenant_id?: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectPhase extends CatalogueBase {
  output?: string | null;
  exit_rule?: string | null;
  /** Derived by RM from `/pm/gates`. */
  has_gate?: boolean;
}

/** A conveyor capability. Not architecture's business capability. */
export type ConveyorCapability = CatalogueBase;

/**
 * A card type's definition of done. The values are RM's enum, read at runtime
 * from `GET /api/conveyor/catalogue/enums` (`getCatalogueEnums`) — fr keeps no
 * copy of the list, so a value RM adds or retires needs no fr release.
 */
export type DefinitionOfDone = string;

/** List attributes: `null` = not set, `[]` = cleared. */
export interface CardType extends CatalogueBase {
  capability_id: string;
  inputs?: string[] | null;
  outputs?: string[] | null;
  acceptance?: string[] | null;
  rules?: string[] | null;
  /** `null` = not set; an explicit false is kept. */
  human_task?: boolean | null;
  definition_of_done?: DefinitionOfDone | null;
}

export interface ProjectTypePhase {
  phase_id: string;
  name: string;
  title: string;
  position: number;
  has_gate?: boolean;
}

export interface ProjectType extends CatalogueBase {
  phases?: ProjectTypePhase[];
}

export const APPROVER_ROLES = ['project_owner', 'tenant_admin', 'member', 'super_admin'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

/** `/pm/gates` — a gate guards a phase's exit (the phase's derived `has_gate`). */
export interface Gate extends CatalogueBase {
  phase_id: string;
  approver_role?: ApproverRole | string;
  quorum?: number;
  /** null = never expires. */
  expires_after_hours?: number | null;
}

// --- matrix -------------------------------------------------------------------

export interface MatrixCardType {
  card_type_id: string;
  name: string;
  title: string;
  /** Tier 1: the phase starts with this card type. Absent on an older RM. */
  is_entry?: boolean;
}

export interface MatrixCapability {
  capability_id: string;
  name: string;
  title: string;
  card_types: MatrixCardType[];
}

export interface MatrixPhase {
  phase_id: string;
  name: string;
  title: string;
  position: number;
  /**
   * The EFFECTIVE value — this project type's override, else the phase's.
   * ⛔ Display only. Never copy it into a PUT: PUT `output` SETS the override,
   * so sending the effective value would freeze the phase's value as an override.
   */
  output?: string | null;
  output_overridden?: boolean;
  /** This project type's own override (what PUT `output` sets); null = no override. */
  output_override?: string | null;
  /** Effective exit rule (display only — same trap as `output`). */
  exit_rule?: string | null;
  exit_rule_overridden?: boolean;
  /** This project type's own override (what PUT `exit_rule` sets); null = no override. */
  exit_rule_override?: string | null;
  has_gate?: boolean;
  capabilities: MatrixCapability[];
}

export interface ProjectTypeMatrix {
  project_type_id: string;
  name: string;
  title: string;
  phases: MatrixPhase[];
}

/**
 * One phase of the matrix PUT. A phase left out of the body loses its card
 * types (its overrides are kept). Per listed phase an omitted
 * `entry_card_type_ids` / `output` / `exit_rule` is UNCHANGED; `output` /
 * `exit_rule` carry the OVERRIDE (GET `output_override`), null = no override.
 */
export interface MatrixPhasePut {
  phase_id: string;
  card_type_ids: string[];
  /** A subset of `card_type_ids`: the card types the phase starts with. */
  entry_card_type_ids?: string[];
  output?: string | null;
  exit_rule?: string | null;
}

export interface ProjectTypeMatrixPut {
  phases: MatrixPhasePut[];
}

// --- Tier 2 (read-only in fr for now) -----------------------------------------

/** `/pm/wip-limits` — one per scope; a null dimension = any. */
export interface WipLimit {
  id: string;
  tenant_id?: string;
  wip_limit: number;
  project_type_id?: string | null;
  phase_id?: string | null;
  capability_id?: string | null;
  card_type_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** `/pm/priority-levels` — names p0..p3 (titles P0..P3); `rank` 0 is the highest. */
export interface PriorityLevel extends CatalogueBase {
  rank: number;
  is_default?: boolean;
  conveyor_may_set?: boolean;
}

/** `/pm/deliverable-kinds`. */
export interface DeliverableKind extends CatalogueBase {
  counts_for_phase_exit?: boolean;
}

/** `/pm/milestone-kinds`; `phase_id` null = any phase. */
export interface MilestoneKind extends CatalogueBase {
  phase_id?: string | null;
}

export interface BoardListSpec {
  name: string;
  position: number;
  closed?: boolean;
}

export interface BoardLabelSpec {
  name: string;
  color?: string | null;
}

export interface CustomFieldGroupSpec {
  name: string;
  fields?: string[];
}

/** `/pm/board-templates`; every list `null` = not set, `[]` = cleared. */
export interface BoardTemplate extends CatalogueBase {
  project_type_id?: string | null;
  lists?: BoardListSpec[] | null;
  labels?: BoardLabelSpec[] | null;
  custom_field_groups?: CustomFieldGroupSpec[] | null;
}

/** RM's per-collection import counts. `filled` is Tier 1. */
export interface ImportCounts {
  created: number;
  existing: number;
  filled?: number;
}

/** `POST import-defaults`. Collections beyond the four base ones are Tier 1+. */
export type ImportDefaultsResult = Record<string, ImportCounts | string[] | undefined>;

// --- results ------------------------------------------------------------------

export interface CatalogueFailure {
  ok: false;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** `error.code` (or the bare `error` string) of the body; null when none. */
  code: string | null;
  /** One sentence, from the body via the shared formatter. */
  message: string;
  /** The parsed error body as received, for verbatim display. */
  body: unknown;
  /**
   * RM is unreachable or fr could not name the tenant (MISSING_TENANT, 5xx, no
   * answer): the catalogue cannot be read at all, which is NOT "empty".
   */
  unavailable: boolean;
}

export type CatalogueResult<T> = { ok: true; data: T } | CatalogueFailure;

const BASE = '/api/conveyor/catalogue';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `error.code`, or `error` when the backend answered a bare string code. */
export function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const err = body.error;
  if (typeof err === 'string') return err;
  if (isRecord(err) && typeof err.code === 'string') return err.code;
  return null;
}

export function isUnavailable(status: number, code: string | null): boolean {
  return status === 0 || status >= 500 || code === 'MISSING_TENANT';
}

/** Turn a non-2xx Response into a failure. Never throws. */
export async function failureOf(r: Response): Promise<CatalogueFailure> {
  const text = await r.text().catch(() => '');
  let body: unknown = text;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  const code = errorCodeOf(body);
  const fallback = `HTTP ${r.status}`;
  const message =
    typeof body === 'string' ? body.trim() || fallback : formatApiError(body, fallback);
  return { ok: false, status: r.status, code, message, body, unavailable: isUnavailable(r.status, code) };
}

/** A request that got no answer (network down, fetch threw). */
export function unreachable(e: unknown): CatalogueFailure {
  const message = e instanceof Error && e.message ? e.message : 'The catalogue could not be reached';
  return { ok: false, status: 0, code: null, message, body: null, unavailable: true };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<CatalogueResult<T>> {
  return callUrl<T>(`${BASE}${path}`, init);
}

async function callUrl<T>(url: string, init: RequestInit = {}): Promise<CatalogueResult<T>> {
  let r: Response;
  try {
    r = await authFetch(url, init);
  } catch (e) {
    return unreachable(e);
  }
  // A fetch layer that resolves with no Response (a stubbed authFetch, a
  // misbehaving interceptor) is "no answer", never a TypeError thrown out of
  // a `.then` the page did not expect to reject.
  if (r == null || typeof (r as { ok?: unknown }).ok !== 'boolean') {
    return unreachable(new Error(`No response from ${url}`));
  }
  if (!r.ok) return failureOf(r);
  try {
    // The route answers `{ data }` (fr's envelope ratchet).
    const json = (await r.json()) as { data: T };
    return { ok: true, data: json.data };
  } catch (e) {
    return unreachable(e);
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function seg(v: string): string {
  return encodeURIComponent(v);
}

/**
 * List query keys the backend forwards (`PM_CATALOGUE_LIST_PARAMS`). RM filters
 * on IDS; a name-keyed `project_type` / `phase` would be silently ignored.
 */
export interface CatalogueListParams {
  limit?: number;
  offset?: number;
  capability_id?: string;
  project_type_id?: string;
  phase_id?: string;
  card_type_id?: string;
  size?: string;
}

/** RM's maximum page; the catalogue is a tenant vocabulary, not a data set. */
export const CATALOGUE_PAGE = 1000;

export function listQuery(params: CatalogueListParams = {}): string {
  const sp = new URLSearchParams();
  sp.set('limit', String(params.limit ?? CATALOGUE_PAGE));
  for (const key of ['offset', 'capability_id', 'project_type_id', 'phase_id', 'card_type_id', 'size'] as const) {
    const v = params[key];
    if (v !== undefined && v !== '') sp.set(key, String(v));
  }
  return `?${sp.toString()}`;
}

export function listCatalogue<T>(
  resource: CatalogueResource,
  params?: CatalogueListParams,
): Promise<CatalogueResult<T[]>> {
  return call<T[]>(`/${resource}${listQuery(params)}`);
}

export function getCatalogueItem<T>(resource: CatalogueResource, id: string): Promise<CatalogueResult<T>> {
  return call<T>(`/${resource}/${seg(id)}`);
}

export function createCatalogueItem<T>(resource: CatalogueResource, body: unknown): Promise<CatalogueResult<T>> {
  return call<T>(`/${resource}`, jsonInit('POST', body));
}

export function updateCatalogueItem<T>(
  resource: CatalogueResource,
  id: string,
  body: unknown,
): Promise<CatalogueResult<T>> {
  return call<T>(`/${resource}/${seg(id)}`, jsonInit('PUT', body));
}

export function deleteCatalogueItem(resource: CatalogueResource, id: string): Promise<CatalogueResult<unknown>> {
  return call<unknown>(`/${resource}/${seg(id)}`, { method: 'DELETE' });
}

export function getProjectTypeMatrix(projectTypeId: string): Promise<CatalogueResult<ProjectTypeMatrix>> {
  return call<ProjectTypeMatrix>(`/project-types/${seg(projectTypeId)}/card-types`);
}

export function setProjectTypeMatrix(
  projectTypeId: string,
  body: ProjectTypeMatrixPut,
): Promise<CatalogueResult<ProjectTypeMatrix>> {
  return call<ProjectTypeMatrix>(`/project-types/${seg(projectTypeId)}/card-types`, jsonInit('PUT', body));
}

export function importCatalogueDefaults(): Promise<CatalogueResult<ImportDefaultsResult>> {
  return call<ImportDefaultsResult>('/import-defaults', { method: 'POST' });
}

// --- catalogue_not_initialised ----------------------------------------------
//
// A tenant whose RM catalogue has no phases or no project types is NOT
// INITIALISED: every fr endpoint that needs its vocabulary answers
// `409 { code: 'catalogue_not_initialised', details: { tenant_id, missing } }`
// (backend services/catalogue/tenant-catalogue.ts). There is no fallback list
// anywhere. A super-admin can seed it (below); everyone else sees a message.

export const CATALOGUE_NOT_INITIALISED = 'catalogue_not_initialised';

export interface CatalogueNotInitialisedInfo {
  /** The tenant whose catalogue is empty; null when the body did not name it. */
  tenantId: string | null;
  missing: string[];
}

/** The not-initialised detail of an error body, or null when it is some other error. */
export function catalogueNotInitialisedOf(body: unknown): CatalogueNotInitialisedInfo | null {
  if (!isRecord(body) || body.code !== CATALOGUE_NOT_INITIALISED) return null;
  const details = isRecord(body.details) ? body.details : {};
  return {
    tenantId: typeof details.tenant_id === 'string' ? details.tenant_id : null,
    missing: Array.isArray(details.missing) ? details.missing.filter((m): m is string => typeof m === 'string') : [],
  };
}

/** Super-admin: `POST /api/admin/tenants/:tenantId/catalogue/import-defaults` (RM import-defaults for that tenant). */
export function importTenantCatalogueDefaults(tenantId: string): Promise<CatalogueResult<ImportDefaultsResult>> {
  return callUrl<ImportDefaultsResult>(`/api/admin/tenants/${seg(tenantId)}/catalogue/import-defaults`, {
    method: 'POST',
  });
}

// --- the tenant's project types, through fr's catalogue reader -----------------

/** A project type as `GET /api/conveyor/project-types` answers it (phases in RM order). */
export interface TenantProjectType {
  name: string;
  title: string;
  description: string | null;
  phases: Array<{ name: string; title: string; position: number; has_gate: boolean }>;
  /**
   * The type can START a project: RM has not retired it (`retired_at` null) AND
   * its RM phase list starts with `setup` (v4). A retired type is still listed —
   * history — it just cannot be offered in the picker.
   */
  startable: boolean;
}

/**
 * The caller tenant's project types with their ordered phases. Unlike
 * `listCatalogue('project-types')` (the raw RM proxy, which answers `[]` for an
 * empty tenant), an empty catalogue comes back as a 409 failure whose body
 * `catalogueNotInitialisedOf` recognises.
 */
export function listTenantProjectTypes(): Promise<CatalogueResult<TenantProjectType[]>> {
  return callUrl<TenantProjectType[]>('/api/conveyor/project-types');
}

/**
 * The caller tenant's priority levels, ordered by rank (GET
 * /api/conveyor/priority-levels). An empty catalogue is a 409 failure.
 */
export function listTenantPriorityLevels(): Promise<CatalogueResult<TenantPriorityLevel[]>> {
  return callUrl<TenantPriorityLevel[]>('/api/conveyor/priority-levels');
}

// --- enums ----------------------------------------------------------------------

/** `GET /api/conveyor/catalogue/enums` — RM's enum values the catalogue forms offer. */
export interface CatalogueEnums {
  definition_of_done: string[];
}

/**
 * The catalogue's enum values, read from RM through fr. The route answers
 * `{ definition_of_done: [...] }`; a `{ data: {...} }` envelope is accepted
 * too. A body without a string-array `definition_of_done` is a failure, never
 * an empty list.
 */
export async function getCatalogueEnums(): Promise<CatalogueResult<CatalogueEnums>> {
  const url = `${BASE}/enums`;
  let r: Response;
  try {
    r = await authFetch(url);
  } catch (e) {
    return unreachable(e);
  }
  if (r == null || typeof (r as { ok?: unknown }).ok !== 'boolean') {
    return unreachable(new Error(`No response from ${url}`));
  }
  if (!r.ok) return failureOf(r);
  let json: unknown;
  try {
    json = await r.json();
  } catch (e) {
    return unreachable(e);
  }
  const body = isRecord(json) && isRecord(json.data) ? json.data : json;
  const dod = isRecord(body) ? body.definition_of_done : undefined;
  if (!Array.isArray(dod) || !dod.every((d) => typeof d === 'string')) {
    return {
      ok: false,
      status: r.status,
      code: null,
      message: 'The catalogue enums answer carried no definition_of_done list',
      body: json,
      unavailable: false,
    };
  }
  return { ok: true, data: { definition_of_done: dod as string[] } };
}
