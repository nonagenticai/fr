// src/services/phase-gate-report.ts
// PHASE-GATE REPORTS (George ruling 2026-10-08). Each time a project's MACRO
// phase actually advances (RM's phase write answered `changed: true` through
// fr's PATCH /api/projects/:id/phase proxy — RM owns the phase, George
// 2026-10-13), fr records ONE `project_reports` row snapshotting the project at
// that moment. Before this, nothing in fr wrote `project_reports` for ordinary
// projects, so every project's Reports tab was empty.
//
// ⛔ BEST-EFFORT BUT LOUD. The phase advance has already committed when this
// runs; a report-write failure must never fail, roll back or delay-into-error
// the advance. Every failure is swallowed into `reportSwallowedFailure` so it
// still shows in the integration_error telemetry. This function never throws.
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, projectReports, projects, departments } from '../db/client';
import * as reportingDomain from '../domain/reporting';
import type { ProjectStatus } from '../domain/reporting';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { wsManager } from '../domain/engagement/adapters/websocket';

const PHASE_GATE_REPORT_TYPE = 'phase_gate';
const PHASE_GATE_GENERATED_BY = 'fr:phase-gate';

interface PhaseGateReportInput {
  projectId: string;
  /**
   * The caller's view of the tenant. Used only when the project itself is
   * un-attributable — the project's own dept/project_data chain is
   * authoritative (it is what `projectStatus` checks against).
   */
  tenantId?: string | null;
  fromPhase: string;
  toPhase: string;
  approvalId?: string | null;
  decidedBy?: string | null;
  source: 'contract_gate_approval' | 'phase_webhook' | (string & {});
}

interface PhaseGateReportResult {
  written: boolean;
  /** Set when `written`; also set to the EXISTING row's id on a replay. */
  reportId?: string;
  reason?: 'duplicate' | 'error';
}

/**
 * sha256 of the transition identity. Same project + same from → to is the SAME
 * gate, so a replayed callback / double-fired stamp maps to one row. Lowercase
 * hex, 64 chars — the shape `project_reports_content_hash_hex` (migration 147)
 * requires, and covered by the partial UNIQUE (tenant_id, content_hash).
 */
function phaseGateContentHash(projectId: string, fromPhase: string, toPhase: string): string {
  return createHash('sha256')
    .update(`phase_gate:${projectId}:${fromPhase}:${toPhase}`)
    .digest('hex');
}

/** Project → tenant, same chain as resolveReportTenant step 2 / projectStatus. */
async function resolveProjectTenant(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({
      deptTenant: departments.workspace_id,
      dataTenant: sql<string | null>`${projects.project_data}->>'keycloak_tenant_id'`,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.deptTenant ?? row?.dataTenant ?? null;
}

/** One line: the transition, who passed it, and what the board looked like. */
function summarise(input: PhaseGateReportInput, snapshot: ProjectStatus | null): string {
  const parts = [`${input.fromPhase} → ${input.toPhase}`];
  parts.push(input.decidedBy ? `approved by ${input.decidedBy}` : `via ${input.source}`);
  if (snapshot) {
    const lists = snapshot.boardProgress?.lists ?? null;
    if (lists) {
      // A null cardCount is "could not read" — never fold it into a number.
      const known = lists.filter((l) => l.cardCount !== null);
      const cards = known.reduce((n, l) => n + (l.cardCount ?? 0), 0);
      const exact = known.length === lists.length && known.every((l) => l.cardCountComplete);
      parts.push(`${cards}${exact ? '' : '+'} cards across ${lists.length} lists`);
    }
    parts.push(`${snapshot.openApprovals.length} open approvals`);
  }
  return parts.join(' · ');
}

/**
 * Record the phase-gate report for a transition that has ALREADY happened.
 * Call only when RM's phase write answered `changed: true`.
 * Never throws.
 */
export async function recordPhaseGateReport(
  input: PhaseGateReportInput,
): Promise<PhaseGateReportResult> {
  try {
    const contentHash = phaseGateContentHash(input.projectId, input.fromPhase, input.toPhase);

    // Replay defence BEFORE any snapshot work. The partial UNIQUE index only
    // dedupes non-NULL tenants, so this check is the guard for the rest.
    const [existing] = await db
      .select({ id: projectReports.id })
      .from(projectReports)
      .where(
        and(
          eq(projectReports.project_id, input.projectId),
          eq(projectReports.report_type, PHASE_GATE_REPORT_TYPE),
          eq(projectReports.content_hash, contentHash),
        ),
      )
      .limit(1);
    if (existing) return { written: false, reportId: existing.id, reason: 'duplicate' };

    const tenantId = (await resolveProjectTenant(input.projectId)) ?? input.tenantId ?? null;

    let snapshot: ProjectStatus | null = null;
    let snapshotError: string | null = null;
    if (!tenantId) {
      snapshotError = 'project has no resolvable tenant';
    } else {
      try {
        snapshot = await reportingDomain.projectStatus(input.projectId, tenantId);
      } catch (err) {
        // A failed snapshot still gets its report — the gate WAS passed.
        snapshotError = err instanceof Error ? err.message : String(err);
        reportSwallowedFailure(err, {
          service: 'fr',
          method: 'phase-gate-report.snapshot',
          degradedTo: 'phase_gate report without snapshot',
        });
      }
    }
    if (!tenantId) {
      console.warn(
        `[phase-gate-report] project ${input.projectId} has no tenant — report stored with NULL tenant_id (invisible until attributable)`,
      );
    }

    const details: Record<string, unknown> = {
      from_phase: input.fromPhase,
      to_phase: input.toPhase,
      approval_id: input.approvalId ?? null,
      decided_by: input.decidedBy ?? null,
      source: input.source,
      snapshot,
    };
    if (snapshotError) details.snapshot_error = snapshotError;

    const [report] = await db
      .insert(projectReports)
      .values({
        tenant_id: tenantId,
        project_id: input.projectId,
        report_type: PHASE_GATE_REPORT_TYPE,
        title: `Phase gate passed: ${input.fromPhase} → ${input.toPhase}`,
        summary: summarise(input, snapshot),
        details,
        generated_by: PHASE_GATE_GENERATED_BY,
        content_hash: contentHash,
      })
      // Lost a concurrent race on (tenant_id, content_hash): the winner's row
      // is the report, ours is a duplicate.
      .onConflictDoNothing()
      .returning();
    if (!report) return { written: false, reason: 'duplicate' };

    try {
      wsManager.publishReport(report);
    } catch (err) {
      reportSwallowedFailure(err, {
        service: 'fr',
        method: 'phase-gate-report.publish',
        degradedTo: 'report stored, live push skipped',
      });
    }
    console.log(
      `[phase-gate-report] project ${input.projectId} ${input.fromPhase} → ${input.toPhase} (${input.source}) → report ${report.id}`,
    );
    return { written: true, reportId: report.id };
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr',
      method: 'phase-gate-report.record',
      degradedTo: 'phase advanced without a phase_gate report',
    });
    return { written: false, reason: 'error' };
  }
}
