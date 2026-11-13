// src/services/catalogue/project-state.ts
//
// THE ONE READER of a project's TYPE, current PHASE and PRIORITY (George
// 2026-10-13: RM owns all three, n8n is the ONLY phase writer, fr only READS
// them). The priority is RM's `priority_level_id`, resolved to the level's
// rank + name through the tenant catalogue — fr keeps NO priority copy in
// project_data (v4: RM is the source of truth). Every fr reader
// of a project's type, phase or priority — GET /api/projects/:id/phase, the cockpit rail,
// next_gate, the WIP claim scope, the project list/detail serialisers — asks
// HERE, and this module asks requirements_management for the project's
// pm_project (integrations/pm.ts). fr's own `projects.project_type` /
// `project_phase` columns are no longer read (they stay in place; a follow-up
// migration drops them; no project is backfilled — George 2026-10-13: every
// pre-v4 project is wiped).
//
// THE LINK (R345, R351 (6)). RM `pm_projects` is the authority for an fr
// project's RM id: the RM row whose `origin_project_id` is the fr project id
// (`GET /pm/projects?origin_project_id=`). RM holds at most ONE such row per
// tenant for life (UNIQUE(tenant_id, origin_project_id), closed rows included),
// so the lookup either finds it or finds none. fr stores NO copy of the RM id:
// every reader resolves it here, through RM.
//
// THE BOARD CACHE. `projects.planka_board_id` / `planka_project_id` are a
// CACHE of RM's board link (RM's `planka_board_id` / `planka_project_id`),
// written only from RM's answer: at create from the board-link PUT's answer,
// and on every RM read here when RM's board differs from the cached one
// (`syncBoardCache`). Planka webhooks, the board UI and every other
// board-id reader keep reading the column.
//
// ⛔ RM-ONLY, NO FALLBACK. A project with no pm_project is 409
// `rm_project_missing`; an RM outage is the IntegrationError. Nothing here
// reads fr's columns to fill a gap.
//
// CACHE. Per PROJECT, TTL 60 s — positive answers and RM's "no pm_project"
// (409 rm_project_missing) alike. The create path invalidates the project's
// entry, so an fr-side write is visible on the next read; the PM's own RM writes
// (the phase, later brief versions) show within the TTL. Any other failed read
// is never cached. (fr's phase proxy, PATCH /api/projects/:id/phase, is retired — D15/R16.)

import {
  closePmProjectInTenant,
  createPmProjectForFrProject,
  getPmProjectBriefVersion,
  getPmProjectCapabilities,
  listPmProjectBriefVersions,
  listPmProjectCapabilityEvents,
  listProjectsByOrigin,
  listProjectsInTenant,
  linkPmProjectPlankaBoard,
  type PmBriefVersionOut,
  type PmBriefVersionSummaryOut,
  type PmProjectCapabilitiesOut,
  type PmProjectCapabilityEventOut,
  type PmProjectRow,
  PM_PROJECT_CLOSED_STATUS,
} from '../../integrations/pm';
import type { FrCreateRmIntake } from './project-intake';
import { db, projects } from '../../db/client';
import { eq } from 'drizzle-orm';
import { isIntegrationError, reportSwallowedFailure } from '../../integrations/_lib/errors';
import type { PhaseSpec } from '../../lib/project-phase';
import { AppError } from '../../utils/errors';
import {
  priorities,
  projectCatalogueTenant,
  projectTypes,
  PROJECT_TYPE_MISSING,
  PROJECT_TYPE_NOT_IN_CATALOGUE,
} from './tenant-catalogue';

// ── the link ────────────────────────────────────────────────────────────────

export const RM_PROJECT_MISSING = 'rm_project_missing';

/** True iff `err` is the 409 "RM holds no pm_project for this fr project". */
export function isRmProjectMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === RM_PROJECT_MISSING;
}

/** The fields of an fr project row this module reads (never its type/phase columns). */
export interface ProjectStateRow {
  id: string;
  name?: string | null;
  project_data?: unknown;
  /** The cached board id; present ⇒ the cache is refreshed from RM's answer (`syncBoardCache`). */
  planka_board_id?: string | null;
}

/** An fr project's type and phase, as RM holds them. */
export interface RmProjectState {
  projectId: string;
  tenantId: string;
  rmPmProjectId: string;
  projectTypeId: string | null;
  /** The type's NAME in the tenant catalogue; null when no type (or the id is not in the catalogue). */
  projectType: string | null;
  /** The current phase's NAME; null when RM holds no phase yet. */
  phase: string | null;
  phaseId: string | null;
  phaseUpdatedAt: string | null;
  /** The project's priority as RM holds it (`priority_level_id`); null when RM holds none. */
  priority: RmProjectPriority | null;
  /**
   * The pm_project row itself: RM's intake + the CURRENT brief (`brief`,
   * `brief_version`, `brief_author_kind`, `brief_updated_at`) — the ONLY copy of
   * them (fr keeps none). Read it through `project-intake.ts frIntakeFieldsFromRm`.
   */
  pm: PmProjectRow;
}

/**
 * A project's RM priority: the level id RM stores, resolved against the
 * project tenant's priority levels. `rank` (lower = more urgent) and `name`
 * are null only when the id is not (or no longer) one of the tenant's levels.
 */
interface RmProjectPriority {
  levelId: string;
  name: string | null;
  title: string | null;
  rank: number | null;
}

// ── cache ───────────────────────────────────────────────────────────────────

const PROJECT_STATE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: Promise<RmProjectState> }>();

/** Drop the cached state of `projectId` (fr's phase proxy + create call this). */
function invalidateProjectState(projectId: string): void {
  cache.delete(projectId);
}

// ── resolution ──────────────────────────────────────────────────────────────

function missing(project: ProjectStateRow, tenantId: string): AppError {
  return new AppError(
    409,
    `project ${project.id} has no requirements_management pm_project (origin_project_id = the fr project id); ` +
      'its type and phase are unknown (no project is backfilled; RM is written only at create)',
    { tenant_id: tenantId },
  ).withCode(RM_PROJECT_MISSING);
}

/**
 * THE pm_project of `project` among `rows`: the one whose `origin_project_id`
 * is the fr project id (RM holds at most one per tenant), else 409
 * `rm_project_missing`.
 */
export function pmProjectOf(project: ProjectStateRow, tenantId: string, rows: readonly PmProjectRow[]): PmProjectRow {
  const own = rows.find((r) => r.origin_project_id === project.id);
  if (!own) throw missing(project, tenantId);
  return own;
}

/**
 * The board-cache write `syncBoardCache` makes, or null when the cache already
 * holds RM's board (or RM holds none, or the caller passed no cached value).
 */
export function boardCacheUpdate(
  project: ProjectStateRow,
  row: Pick<PmProjectRow, 'planka_board_id' | 'planka_project_id'>,
): { planka_board_id: string; planka_project_id?: string } | null {
  const rmBoard = row.planka_board_id ?? null;
  if (project.planka_board_id === undefined || !rmBoard || rmBoard === project.planka_board_id) return null;
  return { planka_board_id: rmBoard, ...(row.planka_project_id ? { planka_project_id: row.planka_project_id } : {}) };
}

/**
 * Refresh `projects.planka_board_id` (a cache) from RM's answer. A failed write
 * leaves the cache as it was and never fails the read: RM's answer is already
 * in hand and is what this read returns.
 */
async function syncBoardCache(project: ProjectStateRow, row: PmProjectRow): Promise<void> {
  const set = boardCacheUpdate(project, row);
  if (!set) return;
  try {
    // No `updated_at` bump: a cache refresh is not an edit of the project (a read stays a read to
    // every client polling `updated_at`).
    await db.update(projects).set(set).where(eq(projects.id, project.id));
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      method: 'UPDATE',
      path: 'projects.planka_board_id',
      degradedTo: `project ${project.id}: board cache not refreshed from RM (RM board ${set.planka_board_id})`,
    });
  }
}

async function typeNameOf(tenantId: string, typeId: string | null): Promise<string | null> {
  if (!typeId) return null;
  return (await projectTypes(tenantId)).find((t) => t.id === typeId)?.name ?? null;
}

async function priorityOf(tenantId: string, row: PmProjectRow): Promise<RmProjectPriority | null> {
  const levelId = row.priority_level_id ?? null;
  if (!levelId) return null;
  const level = (await priorities(tenantId)).find((l) => l.id === levelId);
  return level
    ? { levelId, name: level.name, title: level.title, rank: level.rank }
    : { levelId, name: row.priority ?? null, title: null, rank: null };
}

async function stateFromRow(project: ProjectStateRow, tenantId: string, row: PmProjectRow): Promise<RmProjectState> {
  const typeId = row.project_type_id ?? null;
  return {
    projectId: project.id,
    tenantId,
    rmPmProjectId: row.id,
    projectTypeId: typeId,
    projectType: await typeNameOf(tenantId, typeId),
    phase: row.current_phase ?? null,
    phaseId: row.current_phase_id ?? null,
    phaseUpdatedAt: row.phase_updated_at ?? null,
    priority: await priorityOf(tenantId, row),
    pm: row,
  };
}

async function loadRow(project: ProjectStateRow, tenantId: string): Promise<PmProjectRow> {
  const row = pmProjectOf(project, tenantId, await listProjectsByOrigin(project.id, tenantId));
  await syncBoardCache(project, row);
  return row;
}

/**
 * The project's type and current phase from RM (tenant from the project's own
 * tag — never the caller's). Cached 60 s per project.
 */
export function projectTypeAndPhase(project: ProjectStateRow): Promise<RmProjectState> {
  const hit = cache.get(project.id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = (async () => {
    const tenantId = projectCatalogueTenant(project);
    return await stateFromRow(project, tenantId, await loadRow(project, tenantId));
  })();
  const entry = { expiresAt: Date.now() + PROJECT_STATE_TTL_MS, value };
  cache.set(project.id, entry);
  // RM's "no pm_project for this project" is an ANSWER, cached like a positive one (same TTL), so a
  // hot path asking again within the TTL makes no RM call. Any other failure is never cached.
  value.catch((err: unknown) => {
    if (!isRmProjectMissing(err) && cache.get(project.id) === entry) cache.delete(project.id);
  });
  return value;
}

/**
 * The RM pm_project id of `project`, resolved through RM (cached 60 s); null iff
 * RM holds no pm_project for it. An RM outage or a project without a tenant tag
 * throws: "not a conveyor project" is RM's answer, never a guess.
 */
export async function rmPmProjectIdOf(project: ProjectStateRow): Promise<string | null> {
  try {
    return (await projectTypeAndPhase(project)).rmPmProjectId;
  } catch (err) {
    if (isRmProjectMissing(err)) return null;
    throw err;
  }
}

/** A project's state, or the reason it could not be read (for list surfaces that must not 500). */
export type ProjectStateOrError = { ok: true; state: RmProjectState } | { ok: false; code: string; message: string };

/**
 * The RM state SOURCE for a set of rows: `projectStatesFor` (below). Named as a
 * type because the delivery reconcile worker
 * (workers/project-delivered-reconcile.ts) takes it as a REQUIRED parameter —
 * ordinary dependency injection, supplied by its only production caller
 * (`startProjectDeliveredReconcileWorker` passes the real `projectStatesFor`),
 * not a test-only hook. It passes the domain value `ProjectStateOrError` — an
 * upstream state, never a replaced transport.
 */
export type ProjectStatesLoader = (
  rows: readonly ProjectStateRow[],
) => Promise<Map<string, ProjectStateOrError>>;

function errorOf(err: unknown): { ok: false; code: string; message: string } {
  const code = (err as { code?: unknown }).code;
  return {
    ok: false,
    code: typeof code === 'string' ? code : 'rm_project_state_unavailable',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * The states of many projects with ONE paged RM list per tenant (the project
 * list), not one GET per project. Each result is cached like a single read.
 */
export async function projectStatesFor(
  rows: readonly ProjectStateRow[],
): Promise<Map<string, ProjectStateOrError>> {
  const out = new Map<string, ProjectStateOrError>();
  const byTenant = new Map<string, ProjectStateRow[]>();
  for (const p of rows) {
    const hit = cache.get(p.id);
    if (hit && hit.expiresAt > Date.now()) {
      try {
        out.set(p.id, { ok: true, state: await hit.value });
        continue;
      } catch (err) {
        // A cached "RM holds no pm_project" answer is the answer; any other failed read was dropped
        // by its own catch and is re-read below.
        if (isRmProjectMissing(err)) {
          out.set(p.id, errorOf(err));
          continue;
        }
      }
    }
    let tenantId: string;
    try {
      tenantId = projectCatalogueTenant(p);
    } catch (err) {
      out.set(p.id, errorOf(err));
      continue;
    }
    const list = byTenant.get(tenantId) ?? [];
    list.push(p);
    byTenant.set(tenantId, list);
  }
  for (const [tenantId, group] of byTenant) {
    let all: PmProjectRow[];
    try {
      all = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await listProjectsInTenant(tenantId, { limit: 1000, offset });
        all.push(...page);
        if (page.length < 1000) break;
      }
    } catch (err) {
      for (const p of group) out.set(p.id, errorOf(err));
      continue;
    }
    for (const p of group) {
      try {
        const row = pmProjectOf(p, tenantId, all);
        await syncBoardCache(p, row);
        const state = await stateFromRow(p, tenantId, row);
        cache.set(p.id, { expiresAt: Date.now() + PROJECT_STATE_TTL_MS, value: Promise.resolve(state) });
        out.set(p.id, { ok: true, state });
      } catch (err) {
        out.set(p.id, errorOf(err));
      }
    }
  }
  return out;
}

// ── a PROJECT's phases ──────────────────────────────────────────────────────

/**
 * The ORDERED phases of a project = the phases of its RM project type (the
 * type id RM holds on its pm_project) in its own tenant's catalogue. 409 when
 * RM holds no type (`project_type_missing`) or the type id is not in that
 * tenant's catalogue (`project_type_not_in_catalogue`): fr invents no list.
 */
export async function phasesOfProject(project: ProjectStateRow): Promise<PhaseSpec[]> {
  const state = await projectTypeAndPhase(project);
  return await phasesOfState(state);
}

/** @see phasesOfProject — for a caller that already holds the state. */
export async function phasesOfState(state: RmProjectState): Promise<PhaseSpec[]> {
  if (!state.projectTypeId) {
    throw new AppError(
      409,
      `project ${state.projectId} has no project type in requirements_management, so it has no phase list`,
      { tenant_id: state.tenantId },
    ).withCode(PROJECT_TYPE_MISSING);
  }
  const all = await projectTypes(state.tenantId);
  const t = all.find((x) => x.id === state.projectTypeId);
  if (!t) {
    throw new AppError(
      409,
      `project type ${state.projectTypeId} is not a project type of tenant ${state.tenantId}`,
      { tenant_id: state.tenantId, project_type_id: state.projectTypeId, allowed: all.map((x) => x.name) },
    ).withCode(PROJECT_TYPE_NOT_IN_CATALOGUE);
  }
  return [...t.phases]
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ name: p.name, title: p.title, has_gate: p.has_gate, phase_id: p.phase_id }));
}

// ── THE ONE WRITE: the create POST ──────────────────────────────────────────
//
// ⛔ George 2026-10-13 (v4, D15/R16), ENFORCED BY RM: after create, any
// fr-delegated write to /pm/projects/{eid} (PUT, DELETE, /phase, brief versions,
// any mutating sub-route — and a get-or-create re-POST landing on an existing
// row) is 403 `project_writes_are_pm_only`. So fr writes the pm_project EXACTLY
// ONCE, with everything: the type, the full intake and the brief (v1). RM sets
// phase `setup` itself. Nothing is PUT later (the board link, which completes
// the request, is the one sub-route RM opens to fr), nothing is deleted on a
// failed create (the caller makes this POST and the board link its LAST
// fallible steps instead). The archive's close (`status: closed`, rm#272) is
// the one later write RM accepts from fr (closeRmProjectOfArchive below).

interface EnsureRmProjectInput {
  projectId: string;
  tenantId: string;
  title: string;
  description?: string | null;
  /** The tenant catalogue's type id. RM requires it (422 project_type_required). */
  projectTypeId: string | null;
  createdByUserId?: string;
  /**
   * The FULL fr intake + brief v1 (`project-intake.ts rmIntakeOfCreate`). RM is
   * the only store of it: fr writes none of it into project_data. Its `brief`
   * is sent ALWAYS (RM: 422 `brief_required`); absent intake ⇒ `brief: {}`.
   */
  intake?: FrCreateRmIntake;
}

interface EnsureRmProjectResult {
  rmPmProjectId: string;
  /** false ⇒ a row of this origin already existed and was returned UNCHANGED (no POST). */
  created: boolean;
}

/**
 * Throws unless `row` is the RM row of fr project `projectId` (its `origin_project_id`): a pure check
 * over RM's answer, applied to the found row and to the POST's answer alike.
 */
export function assertOwnOrigin(row: Pick<PmProjectRow, 'id' | 'origin_project_id'>, projectId: string): void {
  if (row.origin_project_id === projectId) return;
  throw new AppError(
    502,
    `requirements_management answered pm_project ${row.id} (origin_project_id ${row.origin_project_id ?? 'none'}) ` +
      `for fr project ${projectId}; it is not this project's row, so nothing was linked`,
    { rm_pm_project_id: row.id },
  ).withCode('rm_project_origin_mismatch');
}

/**
 * Get-or-create the RM pm_project of a NEW fr project: GET by
 * `origin_project_id` FIRST and return an existing row as is (a retried create;
 * a re-POST onto it would be 403 from RM); POST only when none exists — ONE
 * POST carrying the type, the intake, the brief and the token's secret id.
 * ⛔ FAIL CLOSED: any RM refusal or outage throws, and the caller fails the fr
 * create.
 */
export async function ensureRmProjectForFrProject(input: EnsureRmProjectInput): Promise<EnsureRmProjectResult> {
  const existing = (await listProjectsByOrigin(input.projectId, input.tenantId))[0];
  if (existing) {
    // RM holds at most one row per (tenant, origin_project_id); a row of another origin is never
    // reused as this project's (fail closed: the create fails, nothing is linked).
    assertOwnOrigin(existing, input.projectId);
    invalidateProjectState(input.projectId);
    return { rmPmProjectId: existing.id, created: false };
  }
  const row = await createPmProjectForFrProject(input.tenantId, {
    ...(input.intake ?? {}),
    brief: input.intake?.brief ?? {},
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    origin_project_id: input.projectId,
    project_type_id: input.projectTypeId,
    ...(input.createdByUserId ? { created_by_user_id: input.createdByUserId } : {}),
  });
  assertOwnOrigin(row, input.projectId);
  invalidateProjectState(input.projectId);
  return { rmPmProjectId: row.id, created: true };
}

/**
 * Link the RM pm_project `rmPmProjectId` to the Planka board fr built for it
 * (rm#220). One attempt. The create links inside its transaction
 * (services/rm-board-link.ts `linkBoardInRm`); a member's retry re-sends it.
 */
export async function linkRmProjectPlankaBoard(
  tenantId: string,
  rmPmProjectId: string,
  body: Parameters<typeof linkPmProjectPlankaBoard>[2],
): ReturnType<typeof linkPmProjectPlankaBoard> {
  return await linkPmProjectPlankaBoard(tenantId, rmPmProjectId, body);
}

// ── THE ARCHIVE CLOSE (R351 / rm#272) ───────────────────────────────────────
//
// Archiving an fr project closes its RM pm_project: `PUT /pm/projects/{eid}`
// with `status: closed`, which RM accepts from fr for exactly that (it writes
// only the status). The archive calls this FIRST and fails closed on it.

/** What the archive's RM step did. */
export type RmArchiveClose =
  | { kind: 'closed'; rmPmProjectId: string; alreadyClosed: boolean }
  | { kind: 'no_rm_project'; reason: string };

/**
 * Close the RM pm_project of `project` (resolved FRESH by origin_project_id). RM holding no
 * pm_project for it — no row of that origin, RM's 404 on the close, or a project with no tenant
 * tag (RM rows are created in the tenant it names) — is `no_rm_project`: the archive goes on.
 * Every other RM failure THROWS (the archive must not proceed). An already-closed row is not
 * written again.
 */
export async function closeRmProjectOfArchive(project: ProjectStateRow): Promise<RmArchiveClose> {
  let tenantId: string;
  try {
    tenantId = projectCatalogueTenant(project);
  } catch {
    return { kind: 'no_rm_project', reason: 'the project has no tenant tag' };
  }
  invalidateProjectState(project.id);
  const row = (await listProjectsByOrigin(project.id, tenantId)).find((r) => r.origin_project_id === project.id);
  if (!row) return { kind: 'no_rm_project', reason: `RM holds no pm_project of origin ${project.id}` };
  if (row.status === PM_PROJECT_CLOSED_STATUS) return { kind: 'closed', rmPmProjectId: row.id, alreadyClosed: true };
  try {
    await closePmProjectInTenant(tenantId, row.id, row.title ?? project.name ?? project.id);
  } catch (err) {
    if (isIntegrationError(err) && err.upstreamStatus === 404) {
      return { kind: 'no_rm_project', reason: `RM answered 404 closing pm_project ${row.id}` };
    }
    throw err;
  } finally {
    invalidateProjectState(project.id);
  }
  return { kind: 'closed', rmPmProjectId: row.id, alreadyClosed: false };
}

/**
 * The archive's step 0 (every archive path: services/project-archive.ts and the kata archives in
 * services/katas/core.ts): close the project's RM pm_project, or throw 502 `rm_project_close_failed` (nothing else
 * of the archive has run). No RM project ⇒ logged, the archive goes on.
 */
export async function closeRmProjectOrRefuse(project: { id: string; name?: string | null; project_data?: unknown }): Promise<void> {
  let out;
  try {
    out = await closeRmProjectOfArchive(project);
  } catch (err) {
    console.error(`[projects.archive] closing the RM project of ${project.id} failed; nothing was archived:`, err);
    throw new AppError(
      502,
      "the project's requirements_management project could not be closed, so nothing was archived — retry",
      { project_id: project.id },
    ).withCode('rm_project_close_failed');
  }
  if (out.kind === 'no_rm_project') {
    console.warn(`[projects.archive] project ${project.id}: no RM project to close (${out.reason}); archiving anyway`);
  } else {
    console.log(
      `[projects.archive] project ${project.id}: RM pm_project ${out.rmPmProjectId} ${out.alreadyClosed ? 'was already closed' : 'closed'}`,
    );
  }
}

// ── the INTAKE and the versioned BRIEF (rm#213, George 2026-10-13) ──────────
//
// RM holds the project's intake and its brief as VERSIONS; fr holds no copy.
// The brief readers below never answer from the 60 s cache: a conveyor version
// written straight to RM must be visible on the next read. A fresh read
// refreshes the cache entry.

/** Fresh (uncached) state of a project; refreshes the cache. */
export async function freshProjectState(project: ProjectStateRow): Promise<RmProjectState> {
  invalidateProjectState(project.id);
  return await projectTypeAndPhase(project);
}

/** The project's brief versions, newest first (no snapshots). */
export async function listProjectBriefVersions(
  project: ProjectStateRow,
): Promise<{ state: RmProjectState; versions: PmBriefVersionSummaryOut[] }> {
  const state = await freshProjectState(project);
  const versions: PmBriefVersionSummaryOut[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await listPmProjectBriefVersions(state.tenantId, state.rmPmProjectId, { limit: 1000, offset });
    versions.push(...page);
    if (page.length < 1000) break;
  }
  return { state, versions };
}

/** One full brief version of the project. */
export async function getProjectBriefVersion(project: ProjectStateRow, version: number): Promise<PmBriefVersionOut> {
  const state = await projectTypeAndPhase(project);
  return await getPmProjectBriefVersion(state.tenantId, state.rmPmProjectId, version);
}

// ── the CAPABILITY selection (R260 rm#225; shown read-only by R271) ─────────
//
// The PM (n8n) selects which capabilities the project needs and why; RM stores
// it and its history. fr DISPLAYS it and never writes it (RM's PUT is PM_ONLY).
// Never answered from the 60 s cache: a PM selection written straight to RM
// must be visible on the next read.

/** The project's capability selection plus its whole history (newest first). */
export async function projectCapabilities(project: ProjectStateRow): Promise<{
  state: RmProjectState;
  capabilities: PmProjectCapabilitiesOut;
  events: PmProjectCapabilityEventOut[];
}> {
  const state = await freshProjectState(project);
  return { state, ...(await capabilitiesOfState(state)) };
}

/** @see projectCapabilities — for a caller that already holds the state (the cockpit). */
export async function capabilitiesOfState(state: RmProjectState): Promise<{
  capabilities: PmProjectCapabilitiesOut;
  events: PmProjectCapabilityEventOut[];
}> {
  const capabilities = await getPmProjectCapabilities(state.tenantId, state.rmPmProjectId);
  const events: PmProjectCapabilityEventOut[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await listPmProjectCapabilityEvents(state.tenantId, state.rmPmProjectId, { limit: 1000, offset });
    events.push(...page);
    if (page.length < 1000) break;
  }
  return { capabilities, events };
}
