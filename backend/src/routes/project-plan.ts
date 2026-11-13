// src/routes/project-plan.ts
//
// U-TX-API-PLAN (fr#1482) — GET /api/projects/:id/plan
//
// The per-project PLAN read model (CONVEYOR-TAXONOMY §3 B): the plan's phases
// with their gate markers, each phase's deliverables (cardinality, minter,
// deferred, minted state, attached card counts per list), the current phase,
// and the exit-predicate facts per phase (`evaluatePlanPhases`). DISPLAY ONLY:
// fr never advances a phase from these facts — n8n is the only phase writer
// (in RM; George 2026-10-13). The current phase is read from the project's RM
// pm_project (services/catalogue/project-state.ts), null = not started.
//
//   200 {data: {project_id, legacy: true,  reason: 'legacy, no plan'}}   no template AND no RM link
//   200 {data: {project_id, legacy: false, kind: 'conveyor', ...}}        no template, RM-linked (v4
//               conveyor project): the plan from RM + Planka (services/conveyor-plan.ts); each
//               source that cannot be read is `{available:false, reason}`, never an empty list
//   200 {data: {project_id, legacy: false, template, outline_id, phase_plan_hash,
//               current_phase, phase_updated_at, phases[], facts}}
//   404 project not found / not visible (the read lane every project read uses)
//   409 plan_unresolvable  the project HAS a template but its plan cannot be read
//   502 card_states_unavailable  the board could not be read (card counts would be a guess)
//
// AUTH / TENANCY — identical to GET /api/projects/:id/phase: validateAuth +
// loadProjectForRead (tenant-scoped; cross-tenant for a super-admin in home
// view only). Read-only; writes nothing.
//
// `facts` carries the plan's own recorded keys when the S3 instantiation wrote
// them (size_class, repo_count, risk_flags, optional_phases); an absent key is
// null — "not recorded", never a default.

import { db } from '../db/client';
import { validateAuth } from '../middleware/auth';
import { loadProjectForRead } from '../lib/project-access';
import { computePlanFacts, loadProjectPlan } from '../lib/plan-phase-exit';
import { jsonResponse } from '../utils/response';
import { projectTypeAndPhase, rmPmProjectIdOf } from '../services/catalogue/project-state';
import { loadConveyorPlan } from '../services/conveyor-plan';

const LEGACY_PLAN_REASON = 'legacy, no plan';

function recorded(plan: Record<string, unknown>, key: string): unknown {
  return plan[key] === undefined ? null : plan[key];
}

export async function handleGetProjectPlan(req: Request, projectId: string): Promise<Response> {
  const user = await validateAuth(req);
  const project = await loadProjectForRead(db, user, projectId);

  if (!project.template_id) {
    // A v4 conveyor project never has a template: its plan lives in RM.
    if (await rmPmProjectIdOf(project)) {
      return jsonResponse({ data: await loadConveyorPlan(project) });
    }
    return jsonResponse({ data: { project_id: project.id, legacy: true, reason: LEGACY_PLAN_REASON } });
  }
  const loaded = await loadProjectPlan(project.id);
  if (loaded.kind !== 'plan') {
    const reason = loaded.kind === 'unresolvable' ? loaded.reason : loaded.kind;
    return jsonResponse(
      { error: 'plan_unresolvable', code: 'plan_unresolvable', message: `this project's phase plan cannot be read: ${reason}`, reason },
      409,
    );
  }
  // RM owns the phase (George 2026-10-13): null = not started.
  const state = await projectTypeAndPhase(project);
  let phases;
  try {
    phases = await computePlanFacts(loaded, state.phase);
  } catch (err) {
    console.error(`[project-plan] card states unavailable for project ${project.id}:`, err);
    return jsonResponse(
      {
        error: 'card_states_unavailable',
        code: 'card_states_unavailable',
        message: 'the project board could not be read, so card counts and completion cannot be stated',
      },
      502,
    );
  }
  const plan = loaded.plan as Record<string, unknown>;
  return jsonResponse({
    data: {
      project_id: project.id,
      legacy: false,
      template: { id: loaded.plan.template_id, hash: loaded.plan.template_hash },
      outline_id: loaded.outlineId,
      phase_plan_hash: loaded.planHash,
      current_phase: state.phase,
      phase_updated_at: state.phaseUpdatedAt,
      phases,
      facts: {
        size_class: recorded(plan, 'size_class'),
        repo_count: recorded(plan, 'repo_count'),
        risk_flags: recorded(plan, 'risk_flags'),
        optional_phases: recorded(plan, 'optional_phases'),
      },
    },
  });
}
