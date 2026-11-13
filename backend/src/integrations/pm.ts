// Project-management (PMBOK / CCPM / EVM) asset integration — read-only.
//
// Like architecture.ts, the PM domain is served by the same
// `requirements_management` upstream (port 8921) and its URL builders + types
// already ship in `@fr/service-client-requirements`. This is a thin wrapper
// over the shared `http()` factory; tenant scope is injected automatically by
// createHttpClient (X-Tenant-Id / X-User-Id).
//
// Reads: programmes, projects, risks. RM's schedule apparatus (activities,
// dependencies, buffers, schedule snapshots, what-if and the CPM/CCPM/EVM/
// Monte-Carlo tools) was deleted (R352); fr neither calls nor exposes it.

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import {
  getCreateProjectUrl,
  getGetProgrammeUrl,
  getGetProjectUrl,
  getUpdateProjectUrl,
  getGetRiskUrl,
  getListProgrammesUrl,
  getListProjectsUrl,
  getListRisksUrl,
  getListProjectPhaseEventsUrl,
  getGetProjectBriefVersionUrl,
  getListProjectBriefVersionsUrl,
  type BriefVersionOut,
  type BriefVersionSummaryOut,
  type ProjectBrief,
  type ListProgrammesParams,
  type ListProjectsParams,
  type ListRisksParams,
  type ProgrammeOut,
  type ProjectIn,
  type ProjectOut,
  type ProjectPhaseEventOut,
  type RiskOut,
  type ProjectWipLimitOut,
  getGetProjectCapabilitiesUrl,
  getGetProjectRegistersUrl,
  getGetProjectWipLimitUrl,
  getLinkProjectPlankaBoardUrl,
  getListProjectCapabilityEventsUrl,
  type ProjectBoardLinkIn,
  type ProjectBoardLinkOut,
  type ProjectCapabilitiesOut,
  type ProjectCapabilityEventOut,
  type ProjectRegistersOut,
} from '@fr/service-client-requirements';

const CRUD_TIMEOUT_MS = 30_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'requirements_management',
      baseUrl: config.services.requirements.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // requirements_management resolves the tenant from `X-Tenant-Id` alone
      // (kag_common/auth/__init__.py:409-414 "Pull the license token out of
      // `X-Tenant-Id: Bearer <token>` only"). It never reads `Authorization`.
      sendAuthorization: false,
      // fr's OWN RM licence in the ONLY header RM introspects, plus
      // `X-Effective-Tenant-Id` naming the customer tenant. Unset ⇒ every call
      // is refused before it is sent (R351 (7), `tenantBearerRequired`): no
      // plain-uuid request. See `REQUIREMENTS_SERVICE_TOKEN_ENV`.
      tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,
      tenantBearerRequired: true,
      // Never call RM without a tenant: a tenantless trusted-network call is
      // served RM's DEFAULT tenant — someone else's data — and fr must not
      // patch the gap with its own or the system tenant. No frame tenant ⇒
      // MISSING_TENANT before anything is sent (callers render 409/unavailable).
      requireTenant: true,
    });
  }
  return cachedClient;
}

// --- Programmes -----------------------------------------------------------

export async function listProgrammes(
  params?: Record<string, string>,
): Promise<ProgrammeOut[]> {
  return await http().json<ProgrammeOut[]>(
    getListProgrammesUrl(params as ListProgrammesParams | undefined),
    { method: 'GET' },
  );
}

export async function getProgramme(eid: string): Promise<ProgrammeOut> {
  return await http().json<ProgrammeOut>(getGetProgrammeUrl(eid), { method: 'GET' });
}




// --- Projects -------------------------------------------------------------

export async function listProjects(
  params?: Record<string, string>,
): Promise<ProjectOut[]> {
  return await http().json<ProjectOut[]>(
    getListProjectsUrl(params as ListProjectsParams | undefined),
    { method: 'GET' },
  );
}

export async function getProject(eid: string): Promise<ProjectOut> {
  return await http().json<ProjectOut>(getGetProjectUrl(eid), { method: 'GET' });
}


// ⛔ fr's RM pm_project WRITES are the create, the board link and the archive
// CLOSE (George 2026-10-13, v4 D15/R16; R351 / rm#272). Any other fr-delegated
// write to /pm/projects/{eid} after create is 403 `project_writes_are_pm_only`.
// updateProject / deleteProject / setPmProjectType / setPmProjectPhase /
// deletePmProjectInTenant / createPmProjectBriefVersion stay GONE.

// --- fr ↔ PM project link (origin_project_id) ------------------------------
//
// A PM project row minted from an fr project carries `origin_project_id` = the
// fr project id (measured prod 2026-10-08: 91 of 146 rows, often two per fr
// project — "<title>" and "Intake: <title>"). The regenerated `ProjectIn` now
// carries the origin_* fields too; `PmProjectOrigin` stays as the narrow type
// for the link, and the list filter rides through the generated URL builder,
// which forwards every defined key verbatim.

/** Origin columns the upstream ProjectIn/ProjectOut carry but the client predates. */
interface PmProjectOrigin {
  origin_kind?: string | null;
  origin_project_id?: string | null;
  origin_workflow_run_id?: string | null;
  created_by_user_id?: string | null;
}

export type PmProjectRow = ProjectOut & PmProjectOrigin;

// --- RM project TYPE + current PHASE (George 2026-10-13) --------------------
//
// RM owns a project's type and current phase; the PM (n8n) is the ONLY phase
// writer and fr only READS (PATCH /api/projects/:id/phase is retired — v4
// D15/R16; RM sets `setup` at create). Generated from RM origin/main 7baa83d
// (rm#210 + rm#211, alembic 0054): ProjectOut.project_type_id /
// current_phase_id / current_phase (the NAME) / phase_updated_at,
// ProjectIn.project_type_id,
//   GET /pm/projects/{eid}/phase-events   (list_project_phase_events, newest first)

export type PmProjectPhaseEventOut = ProjectPhaseEventOut;

/**
 * What fr sends to mint (get-or-create) the RM pm_project of an fr project: the
 * link, the type AND the FULL fr intake (rm#213 — George 2026-10-13: RM stores the
 * project with all of the user's intake; fr keeps no copy). `brief` becomes
 * version 1. `origin_kind` is added by `createPmProjectForFrProject`.
 */
type PmProjectForFrProjectIn = Omit<
  PmProjectIn,
  'origin_kind' | 'origin_project_id' | 'project_type_id' | 'brief'
> & {
  /** The fr project id — RM's get-or-create identity is (tenant, origin_project_id, title). */
  origin_project_id: string;
  project_type_id: string | null;
  /**
   * REQUIRED (RM: 422 `brief_required` without it). Every key of RM's
   * ProjectBrief is optional, so a create whose user filled no brief field
   * sends `{}`.
   */
  brief: ProjectBrief;
};

/**
 * `ProjectIn` as fr sends it. RM derives the brief author (user iff fr-delegated,
 * else conveyor) and has no author field in the body (rm#216).
 */
export type PmProjectIn = ProjectIn;

export type PmBriefVersionOut = BriefVersionOut;
export type PmBriefVersionSummaryOut = BriefVersionSummaryOut;

/** The terminal status requirements_management accepts for a PM project. */
export const PM_PROJECT_CLOSED_STATUS = 'closed';

// (The pm_project PUT replay machinery — PROJECT_PUT_KEYS / PM_PROJECT_NEVER_PRESERVE
// / PROJECT_INTAKE_KEYS — is gone with every pm_project PUT: v4 D15/R16.)

function requireTenantId(tenantId: string, op: string): string {
  const t = tenantId?.trim();
  // An explicit tenant or no call: without one the request would ride the
  // ambient frame (or none), and a background archive must never guess.
  if (!t) throw new Error(`pm.${op}: tenantId is required (fail closed)`);
  return t;
}

/**
 * PM project rows minted from fr project `originProjectId`, in `tenantId`.
 *
 * ⚠️ The result is RE-FILTERED client-side on `origin_project_id`. An upstream
 * that predates the `origin_project_id` query param ignores it and returns the
 * tenant's WHOLE list — and the caller closes what this returns. Trusting the
 * server-side filter alone would turn a version skew into "close every PM
 * project in the tenant". A row that does not carry the field matches nothing.
 */
export async function listProjectsByOrigin(
  originProjectId: string,
  tenantId: string,
): Promise<PmProjectRow[]> {
  const tenant = requireTenantId(tenantId, 'listProjectsByOrigin');
  const rows = await http().json<PmProjectRow[]>(
    getListProjectsUrl({
      origin_project_id: originProjectId,
      limit: 1000,
    } as ListProjectsParams),
    { method: 'GET', headers: { 'x-tenant-id': tenant } },
  );
  return (rows ?? []).filter((r) => r?.origin_project_id === originProjectId);
}

/**
 * One page of `tenantId`'s PM projects, origin fields included, with the tenant
 * named explicitly (no ambient frame). For operator scripts walking a tenant
 * outside any request.
 */
export async function listProjectsInTenant(
  tenantId: string,
  page: { limit: number; offset: number },
): Promise<PmProjectRow[]> {
  const tenant = requireTenantId(tenantId, 'listProjectsInTenant');
  return (
    (await http().json<PmProjectRow[]>(
      getListProjectsUrl({ limit: page.limit, offset: page.offset }),
      { method: 'GET', headers: { 'x-tenant-id': tenant } },
    )) ?? []
  );
}

// --- fr-agui P2 (D12, George 2026-10-14): the project shell's READ-ONLY PM library --------
//
// "`/api/assets/pm/*` reads: restored as read-only capabilities over RM in P2,
// for programmes, projects, activities, risks and dependencies." (Activities and
// dependencies went with RM's schedule apparatus, R352.) Restored as
// PROJECT reads (routes/project-pm.ts): the RM rows of ONE fr project, read in
// that project's own tenant (its tag — never the caller's), so a super-admin's
// HOME-view read of another tenant's project reads that tenant. Catalogue and
// row EDITING stay in RM; fr has no PM write here. The quality judges for risk
// stay retired (fr facilitates, never judges).

/** Programme `eid` in `tenantId` (explicit tenant, no ambient frame). */
export async function getProgrammeInTenant(tenantId: string, eid: string): Promise<ProgrammeOut> {
  const tenant = requireTenantId(tenantId, 'getProgrammeInTenant');
  return await http().json<ProgrammeOut>(getGetProgrammeUrl(eid), { method: 'GET', headers: { 'x-tenant-id': tenant } });
}

/** Risks of pm_project `pmProjectId` in `tenantId`, re-filtered on `project_id`. */
export async function listRisksOfPmProject(tenantId: string, pmProjectId: string): Promise<RiskOut[]> {
  const tenant = requireTenantId(tenantId, 'listRisksOfPmProject');
  const rows = await http().json<RiskOut[]>(
    getListRisksUrl({ project_id: pmProjectId, limit: 1000 } as ListRisksParams),
    { method: 'GET', headers: { 'x-tenant-id': tenant } },
  );
  return (rows ?? []).filter((r) => (r as { project_id?: unknown }).project_id === pmProjectId);
}

// --- fr project ↔ RM pm_project: type + phase -------------------------------

/** One pm_project by id, in `tenantId` (explicit tenant, no ambient frame). */
export async function getPmProjectInTenant(tenantId: string, eid: string): Promise<PmProjectRow> {
  const tenant = requireTenantId(tenantId, 'getPmProjectInTenant');
  return await http().json<PmProjectRow>(getGetProjectUrl(eid), {
    method: 'GET',
    headers: { 'x-tenant-id': tenant },
  });
}

/**
 * `POST /pm/projects` for an fr project — THE ONE RM pm_project write fr makes
 * (v4 D15/R16). RM's POST is a get-or-create on (tenant, origin_project_id,
 * title), but a DELEGATED re-POST that lands on an existing row is 403
 * project_writes_are_pm_only — so callers GET by origin first
 * (project-state.ts ensureRmProjectForFrProject) and POST only when none
 * exists. RM requires project_type_id (422 project_type_required) and sets the
 * phase to `setup`. `origin_kind` is 'project' — RM requires it with an
 * origin_project_id.
 */
export async function createPmProjectForFrProject(
  tenantId: string,
  body: PmProjectForFrProjectIn,
): Promise<PmProjectRow> {
  const tenant = requireTenantId(tenantId, 'createPmProjectForFrProject');
  return await http().json<PmProjectRow>(getCreateProjectUrl(), {
    method: 'POST',
    headers: { 'x-tenant-id': tenant },
    body: JSON.stringify({ ...body, origin_kind: 'project' } satisfies ProjectIn),
  });
}

/**
 * `PUT /pm/projects/{eid}` closing the pm_project of an archived fr project (rm#272): for a
 * fr-delegated caller RM accepts exactly this body and writes ONLY `status` (`title` is required
 * by `ProjectIn` and ignored). 404 = no such pm_project in the tenant; anything else from fr is 403.
 */
export async function closePmProjectInTenant(tenantId: string, eid: string, title: string): Promise<PmProjectRow> {
  const tenant = requireTenantId(tenantId, 'closePmProjectInTenant');
  return await http().json<PmProjectRow>(getUpdateProjectUrl(encodeURIComponent(eid)), {
    method: 'PUT',
    headers: { 'x-tenant-id': tenant },
    body: JSON.stringify({ title, status: PM_PROJECT_CLOSED_STATUS } satisfies ProjectIn),
  });
}

// --- the project ↔ Planka board link (rm#220, v4 R73 / D20) -----------------
//
// `PUT /pm/projects/{eid}/planka-board` — fr writes it ONCE, right after it built
// the project's board from RM's board template (createSingleProject step 6),
// BEFORE the conveyor start webhook: n8n resolves a Planka webhook's board/list
// ids to the RM project through this link.
//
// RM's contract: re-sending the stored link is 200 `changed: false`
// (idempotent); a DIFFERENT link once one exists is 403
// `project_writes_are_pm_only` for a fr-delegated caller; a board already linked
// to another project of the tenant is 409 `planka_board_in_use`. Bodies are
// extra=forbid on RM's side.

/** The six conveyor lists, in flow order (RM `CONVEYOR_LISTS`). */
export const PM_CONVEYOR_LISTS = ['TODO', 'READY', 'DOING', 'QA', 'DONE', 'BLOCKED'] as const;
export type PmConveyorList = (typeof PM_CONVEYOR_LISTS)[number];

export type PmProjectBoardLinkIn = ProjectBoardLinkIn;
type PmProjectBoardLinkOut = ProjectBoardLinkOut;

/** `PUT /pm/projects/{eid}/planka-board` in `tenantId` (explicit tenant, no ambient frame). */
export async function linkPmProjectPlankaBoard(
  tenantId: string,
  eid: string,
  body: PmProjectBoardLinkIn,
): Promise<PmProjectBoardLinkOut> {
  const tenant = requireTenantId(tenantId, 'linkPmProjectPlankaBoard');
  return await http().json<PmProjectBoardLinkOut>(getLinkProjectPlankaBoardUrl(encodeURIComponent(eid)), {
    method: 'PUT',
    headers: { 'x-tenant-id': tenant },
    body: JSON.stringify(body),
    // The caller (services/rm-board-link.ts) owns the retry policy — up to 3
    // retries on network / 5xx — so the client's own PUT retry stays out of it.
    noRetry: true,
    timeoutMs: 10_000,
  });
}

/** `GET /pm/projects/{eid}/phase-events`, newest first. */
export async function listPmProjectPhaseEvents(
  tenantId: string,
  eid: string,
  page: { limit: number; offset: number } = { limit: 100, offset: 0 },
): Promise<PmProjectPhaseEventOut[]> {
  const tenant = requireTenantId(tenantId, 'listPmProjectPhaseEvents');
  return (
    (await http().json<PmProjectPhaseEventOut[]>(getListProjectPhaseEventsUrl(eid, page), {
      method: 'GET',
      headers: { 'x-tenant-id': tenant },
    })) ?? []
  );
}

// --- the versioned brief (rm#213 / rm#215) ---------------------------------
//
// RM stores a project's brief as append-only FULL snapshots. ⛔ `constraints`
// are immutable after version 1 (422 brief_constraints_immutable), so a new
// version always echoes the current constraints. `if_current_version` is a
// compare-and-set: a mismatch is 409 brief_version_mismatch; null = "expect no
// brief yet". RM's 4xx reaches the caller as an IntegrationError.

/** `GET /pm/projects/{eid}/brief/versions`, newest first, no snapshots. */
export async function listPmProjectBriefVersions(
  tenantId: string,
  eid: string,
  page: { limit: number; offset: number } = { limit: 100, offset: 0 },
): Promise<PmBriefVersionSummaryOut[]> {
  const tenant = requireTenantId(tenantId, 'listPmProjectBriefVersions');
  return (
    (await http().json<PmBriefVersionSummaryOut[]>(getListProjectBriefVersionsUrl(eid, page), {
      method: 'GET',
      headers: { 'x-tenant-id': tenant },
    })) ?? []
  );
}

/** `GET /pm/projects/{eid}/brief/versions/{brief_version}` — one full snapshot. */
export async function getPmProjectBriefVersion(
  tenantId: string,
  eid: string,
  version: number,
): Promise<PmBriefVersionOut> {
  const tenant = requireTenantId(tenantId, 'getPmProjectBriefVersion');
  return await http().json<PmBriefVersionOut>(getGetProjectBriefVersionUrl(eid, version), {
    method: 'GET',
    headers: { 'x-tenant-id': tenant },
  });
}

// --- the project's CAPABILITY selection (R260 rm#225, read in fr by R271) ---
//
// The PM (n8n) selects which capabilities a project needs; RM stores the
// selection (PUT is PM_ONLY — a fr-delegated PUT is 403
// project_writes_are_pm_only). fr NEVER writes it: these two GETs are the whole
// fr surface.

export type PmProjectCapabilitiesOut = ProjectCapabilitiesOut;
export type PmProjectCapabilityEventOut = ProjectCapabilityEventOut;

/** `GET /pm/projects/{eid}/capabilities` in `tenantId` (explicit tenant, no ambient frame). */
export async function getPmProjectCapabilities(tenantId: string, eid: string): Promise<PmProjectCapabilitiesOut> {
  const tenant = requireTenantId(tenantId, 'getPmProjectCapabilities');
  return await http().json<PmProjectCapabilitiesOut>(getGetProjectCapabilitiesUrl(encodeURIComponent(eid)), {
    method: 'GET',
    headers: { 'x-tenant-id': tenant },
  });
}

/**
 * fr-agui P3 (SPEC §7.4 `projects.get_wip`) — `GET /pm/projects/{eid}/wip-limit`
 * in `tenantId`: the WIP limit RM applies to the project (its own `wip_limit`
 * when set, `source: 'project'`; else the tenant catalogue's row for the
 * project's type / the tenant-global total, `source: 'catalogue'`; else
 * `source: 'none'`). Verified against RM origin/main e69e55f
 * (`src/routers/pm_projects.py` `/{eid}/wip-limit`): RM's
 * `/pm/wip-limits/resolve` takes NO project dimension, so this per-project read
 * is the one fr uses. Read-only — n8n enforces WIP.
 */
export type PmProjectWipLimitOut = ProjectWipLimitOut;
export async function getPmProjectWipLimit(tenantId: string, eid: string): Promise<PmProjectWipLimitOut> {
  const tenant = requireTenantId(tenantId, 'getPmProjectWipLimit');
  return await http().json<PmProjectWipLimitOut>(getGetProjectWipLimitUrl(encodeURIComponent(eid)), {
    method: 'GET',
    headers: { 'x-tenant-id': tenant },
  });
}

/** `GET /pm/projects/{eid}/capabilities/events`, newest first. */
export async function listPmProjectCapabilityEvents(
  tenantId: string,
  eid: string,
  page: { limit: number; offset: number } = { limit: 100, offset: 0 },
): Promise<PmProjectCapabilityEventOut[]> {
  const tenant = requireTenantId(tenantId, 'listPmProjectCapabilityEvents');
  return (
    (await http().json<PmProjectCapabilityEventOut[]>(
      getListProjectCapabilityEventsUrl(encodeURIComponent(eid), page),
      { method: 'GET', headers: { 'x-tenant-id': tenant } },
    )) ?? []
  );
}

// --- Risks ----------------------------------------------------------------

export async function listRisks(params?: Record<string, string>): Promise<RiskOut[]> {
  return await http().json<RiskOut[]>(
    getListRisksUrl(params as ListRisksParams | undefined),
    { method: 'GET' },
  );
}

export async function getRisk(eid: string): Promise<RiskOut> {
  return await http().json<RiskOut>(getGetRiskUrl(eid), { method: 'GET' });
}




// --- project registers (RM #240, REG-1) -------------------------------------
//
// `GET /pm/projects/{eid}/registers?phase=` — a project's risks, decisions, requirements and
// criteria plus the counts fr's Overview strip shows.

export type PmProjectRegistersOut = ProjectRegistersOut;

/** `GET /pm/projects/{eid}/registers` in `tenantId` (explicit tenant, no ambient frame). */
export async function getPmProjectRegisters(
  tenantId: string,
  eid: string,
  phase: string | null = null,
): Promise<PmProjectRegistersOut> {
  const tenant = requireTenantId(tenantId, 'getPmProjectRegisters');
  return await http().json<PmProjectRegistersOut>(getGetProjectRegistersUrl(encodeURIComponent(eid), phase ? { phase } : undefined), {
    method: 'GET',
    headers: { 'x-tenant-id': tenant },
  });
}
