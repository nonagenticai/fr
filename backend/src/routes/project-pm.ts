// src/routes/project-pm.ts
//
// fr-agui SPEC §13 P2 / §16 D12 (George 2026-10-14) — the project shell's
// READ-ONLY PM library, sourced from requirements_management:
//
//   GET /api/projects/:id/pm/projects      the RM pm_projects minted for this fr project
//   GET /api/projects/:id/pm/programmes    the programmes those pm_projects belong to
//   GET /api/projects/:id/pm/risks         their risks
//
// "`/api/assets/pm/*` reads: restored as read-only capabilities over RM … for
// programmes, projects, activities, risks and dependencies … fr PM library UI:
// re-homed read-only in the project shell … Catalogue editing stays in RM."
// Activities (WBS) and dependencies went with RM's schedule apparatus (R352).
//
// Decision (P2, conservative, recorded in the SPEC P2 status line): restored as
// PROJECT reads, not as the retired tenant-wide `/api/assets/pm/*` list routes.
// The project shell and the project agent only ever need ONE project's rows, and
// a tenant-wide PM catalogue is tenant-level work (OQ-6). There is no PM write
// here; the risk quality judge stays retired (fr facilitates, never judges).
//
// Gate: `validateAuth` → `loadProjectForRead` (any member of the project's
// tenant, P1-TEAM-a; the same 404 for every unreadable shape) → RM read in the
// PROJECT's tenant (`projectCatalogueTenant`: its tag, never the caller's, so a
// super-admin's HOME-view read of another tenant's project reads that tenant).
// A project with no tenant tag answers 409 `project_tenant_unknown`.
//
// Every list is re-filtered client-side on the pm_project(s) (an upstream that
// ignores a filter cannot widen the answer). Envelope: `{ data: T[] }`.
import { db as defaultDb } from '../db/client';
import {
  getProgrammeInTenant,
  listProjectsByOrigin,
  listRisksOfPmProject,
  type PmProjectRow,
} from '../integrations/pm';
import { loadProjectForRead } from '../lib/project-access';
import { validateAuth } from '../middleware/auth';
import { projectCatalogueTenant } from '../services/catalogue/tenant-catalogue';
import { handleError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

interface PmScope {
  tenantId: string;
  pmProjects: PmProjectRow[];
}

async function scopeOf(req: Request, projectId: string): Promise<PmScope> {
  const user = await validateAuth(req);
  const project = await loadProjectForRead(defaultDb, user, projectId);
  const tenantId = projectCatalogueTenant(project);
  return { tenantId, pmProjects: await listProjectsByOrigin(projectId, tenantId) };
}

async function eachPmProject<T>(scope: PmScope, read: (pmProjectId: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const p of scope.pmProjects) out.push(...(await read(p.id)));
  return out;
}

/** GET /api/projects/:id/pm/projects */
export async function handleListProjectPmProjects(req: Request, projectId: string): Promise<Response> {
  try {
    const scope = await scopeOf(req, projectId);
    return jsonResponse({ data: scope.pmProjects });
  } catch (err) {
    return handleError(err);
  }
}

/** GET /api/projects/:id/pm/programmes */
export async function handleListProjectPmProgrammes(req: Request, projectId: string): Promise<Response> {
  try {
    const scope = await scopeOf(req, projectId);
    const ids = [
      ...new Set(scope.pmProjects.map((p) => p.programme_id).filter((v): v is string => typeof v === 'string' && v !== '')),
    ];
    const programmes: unknown[] = [];
    for (const id of ids) programmes.push(await getProgrammeInTenant(scope.tenantId, id));
    return jsonResponse({ data: programmes });
  } catch (err) {
    return handleError(err);
  }
}

/** GET /api/projects/:id/pm/risks */
export async function handleListProjectPmRisks(req: Request, projectId: string): Promise<Response> {
  try {
    const scope = await scopeOf(req, projectId);
    const risks = await eachPmProject(scope, (pm) => listRisksOfPmProject(scope.tenantId, pm));
    return jsonResponse({ data: risks });
  } catch (err) {
    return handleError(err);
  }
}
