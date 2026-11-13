// src/lib/project-start-template.ts
//
// U-PS-ROUTE (fr half) + U-PS-ENTRY: a project started FROM A TEMPLATE, and the
// flag that will one day make that the only way to start an orchestrated EXEC
// project (PSD §4 "One entry path"; design D4/D7).
//
// ── THE FLAG: PROJECT_START_TEMPLATE_REQUIRED (default OFF) ──────────────────
// When `true`:
//   * promote of an orchestrated EXEC request whose approved outline carries no
//     phase plan is refused `no_template` (routes/project-requests.ts);
//   * a direct create of an ACTIVE orchestrated EXEC project — POST
//     /api/projects and bulk create — is refused `template_required` (promote
//     is the only path).
// OFF (the default, and the only safe value until pm publishes templates and
// the U-TX-LEGACY cut has George's OK): every one of those paths behaves
// exactly as before. Read at CALL time, so an env change needs no code path
// other than a restart, and tests can toggle it.
//
// ⛔ What is NOT behind the flag, deliberately: a promote whose outline DOES
// carry a plan is stamped as a template start (template_id/hash, phases[0],
// start_mode, contract close) whatever the flag says. It changes no project
// that exists today — no outline carries a plan until pm templates and the ncn
// template start step ship. Its phase thereafter is n8n's to set (PATCH /phase;
// George 2026-10-13), never computed by fr.

import type { PhasePlan } from './phase-plan';

export const PROJECT_START_TEMPLATE_REQUIRED_ENV = 'PROJECT_START_TEMPLATE_REQUIRED';

/** `true` only for the literal string "true" (case-insensitive). Anything else is OFF. */
export function projectStartTemplateRequired(): boolean {
  return (process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV] ?? '').trim().toLowerCase() === 'true';
}

/**
 * What promote hands createSingleProject for a template start: the approved
 * outline version's plan and the approval that decided it. Built ONLY from a
 * stored, decided outline (routes/project-requests.ts) — never from a request
 * body — so no caller of POST /api/projects can claim a template.
 */
export interface ProjectStartTemplate {
  templateId: string;
  templateHash: string;
  phasePlan: PhasePlan;
  phasePlanHash: string;
  outlineId: string;
  outlineVersion: number;
  /** The `project_outline.approval` that decided the outline — the contract close. */
  approvalId: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/**
 * Must THIS create be refused because it starts an orchestrated EXEC project
 * with no template? False whenever the flag is off — the whole point.
 */
export function templateRequiredForCreate(p: {
  orchestrated: boolean;
  ownerTenantId: string;
  execTenantId: string;
  hasTemplate: boolean;
}): boolean {
  if (!projectStartTemplateRequired()) return false;
  return p.orchestrated && p.ownerTenantId === p.execTenantId && !p.hasTemplate;
}

/** The `project_data` keys a template start records (alongside the template_* columns). */
export function templateStartProjectData(t: ProjectStartTemplate): Record<string, unknown> {
  return {
    start_mode: 'template',
    // The outline approval IS the contract close (design D4 "First phase"):
    // a template project never passes through `contract` on the rail, so the
    // record of who closed it, and on which outline version, lives here.
    contract_close: {
      source: 'outline_approval',
      approval_id: t.approvalId,
      outline_id: t.outlineId,
      outline_version: t.outlineVersion,
      phase_plan_hash: t.phasePlanHash,
      decided_by: t.decidedBy,
      decided_at: t.decidedAt ? t.decidedAt.toISOString() : null,
    },
  };
}

/**
 * The phase whose GATE the outline approval closes on a template start: of the
 * project type's phases (requirements_management's catalogue, `has_gate`), the
 * LAST gated phase positioned before the plan's first phase — the gate the
 * project passes to enter `phasePlan.phases[0]`.
 *
 * ⛔ No fallback. Gates are approvals of RM-gated phases only: a type with no
 * gated phase before the first plan phase (or a first phase the type does not
 * have) answers null, and the caller records NO phase-gate report rather than
 * inventing a `from` phase. The old literal `'contract'` was fr's local
 * vocabulary and is exactly what this replaces.
 */
export function outlineClosedGatePhase(
  typePhases: ReadonlyArray<{ name: string; position: number; has_gate?: boolean }>,
  firstPlanPhase: string,
): string | null {
  const ordered = [...typePhases].sort((a, b) => a.position - b.position);
  const firstIdx = ordered.findIndex((p) => p.name === firstPlanPhase);
  if (firstIdx <= 0) return null;
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (ordered[i]!.has_gate === true) return ordered[i]!.name;
  }
  return null;
}
