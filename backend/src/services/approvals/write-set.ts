// src/services/approvals/write-set.ts
//
// U4 — resolve the APPROVED, sealed write set of a write-set approval. One reader, two
// callers: GET /api/approvals/:id/write-set (routes/approval-write-set.ts) and the
// constraint-check landing gate's `diff_outside_write_set` (routes/project-constraint-check.ts).
// Contract: src/lib/write-set.ts header (FROZEN 2026-10-02).
//
//   feature  execution.feature_design_approval, status approved. metadata.write_set +
//            metadata.write_set_seal are READ, the seal is RECOMPUTED over exactly what is
//            returned; mismatch ⇒ write_set_seal_mismatch and nothing is returned. Absent
//            set or seal ⇒ write_set_missing (fail-closed: A3 mints after U4 carry it).
//   bug_fix  execution.ready_signoff MARKED metadata.approval_kind='bug_fix_authorization',
//            status approved. The cited bug_report/v1 row is loaded and H_r RECOMPUTED from
//            it (lib/bug-report-hash.ts); it must equal metadata.report_hash, else
//            report_hash_mismatch. The set is DERIVED: ∪ over the APPROVED bug_ids (G-12 A1
//            structured decision ∩ metadata.bug_ids — the approved-items reader's own
//            resolveApprovedBugIds) of { bug.location.file, bug.failing_test.path }. The repro
//            test path is included BY RULING (movies-13, 10-02): the fix PR commits it.
//   other    any other kind / status ⇒ not_a_write_set_approval.
//
// ⛔ TENANT: `tenantId` is REQUIRED — there is no unscoped read. The row is read with
// approvals.tenant_id = tenantId (and the returned row's tenant is re-checked), so a
// cross-tenant id is `approval_not_found` — byte-identical to a missing one. A caller with no
// tenant to scope by (the constraint-check gate on a board with no fr project) must refuse
// BEFORE calling this (write_set_tenant_unresolved), never read unscoped.

import { and, eq } from 'drizzle-orm';

import { approvals, db, projectReports } from '../../db/client';
import { isUuidShape } from '../../lib/uuid-shape';
import { BugReportDetailsSchema, bugReportHash } from '../../lib/bug-report-hash';
import { writeSetSeal } from '../../lib/write-set';
import { WriteSetPathsError, assertWriteSetPaths, compareBytes } from './write-set-paths';
import { isBugFixAuthorizationRow } from '../../domain/engagement/deblock-actions';
import { resolveApprovedBugIds } from '../../routes/approval-approved-items';
import { BUG_FIX_AUTHORISING_KIND, FEATURE_DESIGN_APPROVAL_KIND } from './u3-gates';

export type WriteSetSource = 'feature' | 'bug_fix';

export interface ApprovalWriteSet {
  approval_id: string;
  source: WriteSetSource;
  write_set: string[];
  write_set_seal: string;
}

export type WriteSetRefusalCode =
  | 'approval_not_found'
  | 'not_a_write_set_approval'
  | 'write_set_missing'
  | 'write_set_seal_mismatch'
  | 'write_set_invalid'
  | 'write_set_too_broad'
  | 'report_not_found'
  | 'report_hash_mismatch'
  | 'approval_items_missing'
  | 'no_approved_bugs';

export type WriteSetResolution =
  | { ok: true; data: ApprovalWriteSet }
  | { ok: false; status: 404 | 409; code: WriteSetRefusalCode; message: string };

const refuse = (code: WriteSetRefusalCode, message: string): WriteSetResolution => ({
  ok: false,
  status: code === 'approval_not_found' ? 404 : 409,
  code,
  message,
});

const NOT_FOUND = (): WriteSetResolution => refuse('approval_not_found', 'Approval not found');

export async function resolveApprovalWriteSet(args: {
  approvalId: string;
  tenantId: string;
}): Promise<WriteSetResolution> {
  if (!isUuidShape(args.approvalId) || !isUuidShape(args.tenantId)) return NOT_FOUND();
  const where = and(eq(approvals.id, args.approvalId), eq(approvals.tenant_id, args.tenantId));
  const [row] = await db
    .select({ id: approvals.id, tenant_id: approvals.tenant_id, kind: approvals.kind, status: approvals.status, metadata: approvals.metadata })
    .from(approvals)
    .where(where)
    .limit(1);
  // Belt and braces over the WHERE: a row of another tenant is indistinguishable from none.
  if (!row || row.tenant_id !== args.tenantId) return NOT_FOUND();

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const notWriteSet = () =>
    refuse(
      'not_a_write_set_approval',
      `approval ${row.id} (kind ${row.kind}, status ${row.status}) is not an approved write-set approval`,
    );
  if (row.status !== 'approved') return notWriteSet();

  // ── feature: the sealed A3 write set ──
  if (row.kind === FEATURE_DESIGN_APPROVAL_KIND) {
    if (meta.write_set === undefined || meta.write_set === null || typeof meta.write_set_seal !== 'string') {
      return refuse('write_set_missing', `approval ${row.id} carries no sealed write_set`);
    }
    const v = checkPaths(row.id, meta.write_set as readonly string[]);
    if (!v.ok) return v.refusal;
    const writeSet = [...(meta.write_set as string[])];
    if (writeSetSeal(writeSet) !== meta.write_set_seal) {
      return refuse('write_set_seal_mismatch', `approval ${row.id}: write_set does not match its write_set_seal`);
    }
    return { ok: true, data: { approval_id: row.id, source: 'feature', write_set: writeSet, write_set_seal: meta.write_set_seal } };
  }

  // ── bug fix: derived from the hash-bound report's APPROVED bugs ──
  if (row.kind !== BUG_FIX_AUTHORISING_KIND || !isBugFixAuthorizationRow(row)) return notWriteSet();

  const reportId = typeof meta.report_id === 'string' ? meta.report_id : '';
  const reportHash = typeof meta.report_hash === 'string' ? meta.report_hash : '';
  const [report] = isUuidShape(reportId)
    ? await db
        .select({
          tenant_id: projectReports.tenant_id,
          project_id: projectReports.project_id,
          card_id: projectReports.card_id,
          details: projectReports.details,
        })
        .from(projectReports)
        .where(and(eq(projectReports.id, reportId), eq(projectReports.tenant_id, row.tenant_id), eq(projectReports.report_type, 'bug_report')))
        .limit(1)
    : [];
  if (!report) return refuse('report_not_found', `approval ${row.id}: the cited bug report is not available`);

  // RECOMPUTE H_r from the stored body — never trust the stored content_hash column alone.
  const parsed = BugReportDetailsSchema.safeParse(report.details);
  const recomputed =
    parsed.success && report.tenant_id && report.card_id
      ? bugReportHash({
          tenant_id: report.tenant_id,
          project_id: report.project_id ?? null,
          card_id: report.card_id,
          hunt: parsed.data.hunt,
          repo: parsed.data.repo,
          commit_sha: parsed.data.commit_sha,
          bugs: parsed.data.bugs,
        })
      : null;
  if (recomputed === null || recomputed !== reportHash) {
    return refuse(
      'report_hash_mismatch',
      `approval ${row.id}: the cited bug report no longer hashes to the report_hash this approval was decided on`,
    );
  }

  const approved = await resolveApprovedBugIds(row.id, meta);
  if (approved === null) return refuse('approval_items_missing', `approval ${row.id} has no structured item decision`);
  const bugs = parsed.success ? parsed.data.bugs.filter((b) => approved.has(b.id)) : [];
  if (bugs.length === 0) return refuse('no_approved_bugs', `approval ${row.id} approved no bug of its report`);

  // DERIVATION: de-duplicate + byte-sort, then the same assertion as a stored set.
  const derived = [...new Set(bugs.flatMap((b) => [b.location.file, b.failing_test.path]))].sort(compareBytes);
  const v = checkPaths(row.id, derived, 'derived ');
  if (!v.ok) return v.refusal;
  return {
    ok: true,
    data: { approval_id: row.id, source: 'bug_fix', write_set: derived, write_set_seal: writeSetSeal(derived) },
  };
}

/** assertWriteSetPaths as a refusal (write_set_invalid | write_set_too_broad). */
function checkPaths(
  approvalId: string,
  paths: readonly string[],
  prefix = '',
): { ok: true } | { ok: false; refusal: WriteSetResolution } {
  try {
    assertWriteSetPaths(paths);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof WriteSetPathsError)) throw err;
    return { ok: false, refusal: refuse(err.pathsCode, `approval ${approvalId}: ${prefix}${err.detail}`) };
  }
}
