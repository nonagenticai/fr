// src/routes/project-registers.ts
//
// REG-3 / R2 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.3) — GET /api/projects/:id/registers?phase=
//
// A read-only proxy of requirements_management `GET /pm/projects/{eid}/registers?phase=` (RM #240):
// the project's risks, decisions, requirements and criteria plus the counts the Overview's
// "Registers at a glance" strip shows. `eid` = the project's RM pm_project, resolved from RM by origin_project_id.
//
//   200 {data: {available: true, project_id, rm_project_id, phase, risks[], decisions[], requirements[],
//               criteria[], counts{risks_open, risks_total, decisions, requirements, criteria_met,
//               criteria_total}}}
//   200 {data: {available: false, project_id, reason: 'no_rm_project'}}   the project is not run by
//               the conveyor (no RM link) — there is no register to read, which is not an error
//   422 invalid_phase   `phase` is not a phase name (lowercase, [a-z][a-z0-9_]*, ≤ 64)
//   404 project not found / not visible (the read lane every project read uses)
//   409 project_tenant_unknown  the project carries no tenant tag
//   502 rm_registers_mismatch   RM answered for a different project than the one asked
//   RM failing: its status in the integration envelope (runReadModel)
//
// AUTH / TENANCY — identical to GET /api/projects/:id/cockpit: validateAuth + loadProjectForRead
// (tenant-scoped; another tenant's project is the same 404 as an absent one). RM is asked in the
// PROJECT's tenant (its `keycloak_tenant_id` tag, as every RM read of a project is), never a
// tenant the caller names. fr passes RM's rows through unchanged: it judges nothing.
import { db } from '../db/client';
import { loadProjectForRead } from '../lib/project-access';
import { getPmProjectRegisters, type PmProjectRegistersOut } from '../integrations/pm';
import { rmPmProjectIdOf } from '../services/catalogue/project-state';
import { projectCatalogueTenant } from '../services/catalogue/tenant-catalogue';
import { runReadModel } from '../services/read-models/_lib';
import { AppError, ValidationError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

const REGISTER_PHASE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export async function handleGetProjectRegisters(req: Request, projectId: string): Promise<Response> {
  return runReadModel(req, async (user) => {
    const raw = new URL(req.url).searchParams.get('phase');
    const phase = raw === null || raw.trim() === '' ? null : raw.trim();
    if (phase !== null && !REGISTER_PHASE_RE.test(phase)) {
      throw new ValidationError('phase must be a phase name (lowercase letters, digits, _)', { code: 'invalid_phase' }).withCode('invalid_phase');
    }
    // 404-for-everything tenant gate — never leaks which project ids exist across tenants/owners.
    const project = await loadProjectForRead(db, user, projectId);
    const eid = await rmPmProjectIdOf(project);
    if (!eid) {
      return jsonResponse({ data: { available: false, project_id: project.id, reason: 'no_rm_project' } });
    }
    const tenantId = projectCatalogueTenant(project);
    const out: PmProjectRegistersOut = await getPmProjectRegisters(tenantId, eid, phase);
    if (String(out.project_id) !== eid) {
      throw new AppError(502, 'requirements_management answered for a different project').withCode('rm_registers_mismatch');
    }
    return jsonResponse({
      data: {
        available: true,
        project_id: project.id,
        rm_project_id: eid,
        phase: out.phase ?? phase,
        risks: out.risks ?? [],
        decisions: out.decisions ?? [],
        requirements: out.requirements ?? [],
        criteria: out.criteria ?? [],
        counts: out.counts,
      },
    });
  });
}
