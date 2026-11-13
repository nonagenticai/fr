// src/lib/project-orchestration.ts
//
// The project-start orchestration gate, extracted VERBATIM from
// routes/projects.ts (which re-exports it) so callers outside the route module
// read the ONE rule instead of restating it. Pure; imports nothing but the closed type vocabulary's literal.
// The frontend mirror is ProjectTypeAnalysisWarning.svelte `orchestratesProjectStart`.

/** `system_ops` — SYSTEM-tenant attribution projects; never orchestrated (fr#1487). */
const SYSTEM_OPS_PROJECT_TYPE = 'system_ops';

// Decide whether a newly-created project enters the AA project-start
// orchestration (intake card stamped + moved TODO→READY for the n8n router).
// Two entries:
//   1. Customer CVE-sweep readiness (WS3): an `it` project with cve_sweep=true,
//      on ANY tenant — customers self-serve a discovery CVE sweep on their own
//      repo. Tenant isolation is enforced downstream (intake card stamps the
//      requesting tenant; coding resolves the customer's BYO PAT/container).
//   2. EVERY EXEC-tenant project — the internal AA pipeline. Widened
//      2026-07-07 from `it`/`feature` only to ANY project_type: no internal
//      project should be born bypassing its *_start_request_analysis card
//      (R-SYS / the "any project born bypassing the analysis card" gap). The
//      tenant pin keeps customers isolated — a customer project (any type,
//      no cve_sweep) still does NOT orchestrate, so customers cannot
//      accidentally trigger the pipeline.
// Pure + exported so the gate is unit-testable without the create harness.
export function shouldOrchestrateProjectStart(params: {
  projectType: string | undefined;
  cveSweep: boolean | undefined;
  tenantId: string;
  execTenantId: string;
}): boolean {
  const { projectType, cveSweep, tenantId, execTenantId } = params;
  // `system_ops` (SYSTEM tenant attribution projects) NEVER orchestrates, on
  // any tenant — checked first so no other rule can widen it.
  if (projectType === SYSTEM_OPS_PROJECT_TYPE) return false;
  // legacy (pre-RM) project type
  if (projectType === 'it' && cveSweep === true) return true;
  // Any EXEC-tenant project (any project_type, incl. undefined). fr creates no
  // card for it — n8n's trigger.conveyor_start creates the first one.
  return tenantId === execTenantId;
}
