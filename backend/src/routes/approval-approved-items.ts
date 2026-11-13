// src/routes/approval-approved-items.ts
//
// GET /api/approvals/:approvalId/approved-items — U3, consumed by movies-db's READY and
// decomposition consumers. Returns the RESOLVED APPROVED items of a decided U3 approval,
// one entry per approved item, each keyed by criterion_id.
//
//   bug_fix_authorization MARKED row   ANY kind (generic deblock / execution.ready_signoff)
//   (isBugFixAuthorizationRow)         with metadata.approval_kind='bug_fix_authorization'
//                                      (RULING 10-01). One entry per bug the G-12 A1 decision
//                                      APPROVED (approval_decisions.item_decisions) ∩
//                                      metadata.bug_ids, read from the U2 report the approval
//                                      cites. ⛔ RULING a (10-01): ONLY an approved marked
//                                      execution.ready_signoff row authorises fixes. A marked
//                                      GENERIC row authorises NO fix under ANY deblock_action
//                                      (RETRY included) or none: 409 not_authorised_for_fix,
//                                      never an empty list.
//   execution.feature_design_approval  one entry per scenario in metadata.scenarios. The
//                                      A3 decision has one item (the design), so an
//                                      approved approval approves every scenario.
//
// ⛔ TENANT-PREDICATED, NO BYPASS: the row is read with `approvals.tenant_id = <caller's
// tenant>`; another tenant's approval is a 404, indistinguishable from a missing one.
// ⛔ NEVER AN EMPTY LIST FOR "NOT DECIDED": anything but a decided-APPROVED U3 approval is
// a 409, so a consumer cannot read "nothing approved yet" as "nothing to build".
// An unmarked, non-design row is 409 not_a_bug_fix_authorization.

import { and, eq, isNotNull } from 'drizzle-orm';

import { approvalDecisions, approvals, db, projectReports } from '../db/client';
import { ctxTenantId } from '../middleware/request-context';
import { validateAuth } from '../middleware/auth';
import { isUuidShape } from '../lib/uuid-shape';
import { AppError, NotFoundError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { isBugFixAuthorizationRow } from '../domain/engagement/deblock-actions';
import { FEATURE_DESIGN_APPROVAL_KIND, bugFixDecisionAuthorises } from '../services/approvals/u3-gates';

export interface ApprovedItem {
  scenario_id: string;
  criterion_id: string;
  title: string;
  gherkin: string | null;
  failing_test?: { path: string; name: string };
  status: 'approved';
  source:
    | { kind: 'bug_report'; approval_id: string; artifact_sha256: string; bug_id: string }
    | { kind: 'feature_design'; approval_id: string; artifact_sha256: string };
}

function notApproved(code: string, message: string): never {
  throw new AppError(409, message).withCode(code);
}

interface ReportBug {
  id: string;
  kind: string;
  location: { file: string; line: number };
  failing_test: { path: string; name: string };
}

/** PURE projection — exported for the unit test. */
export function bugFixApprovedItems(input: {
  approvalId: string;
  reportHash: string;
  bugs: readonly ReportBug[];
  approvedBugIds: ReadonlySet<string>;
}): ApprovedItem[] {
  const approved = input.bugs.filter((b) => input.approvedBugIds.has(b.id));
  // ⛔ FAIL LOUDLY ON A PREFIX COLLISION. The ids are `scn_`/`crit_` + bug.id[0:8] (the
  // contract agreed with movies-db). Two approved bugs sharing that 8-hex prefix would
  // emit two entries with the SAME criterion_id — the key the consumer dedupes on — so
  // one approved bug would silently vanish downstream. Refuse instead of emitting either.
  const byPrefix = new Map<string, string>();
  for (const b of approved) {
    const prefix = b.id.slice(0, 8);
    const prior = byPrefix.get(prefix);
    if (prior !== undefined) {
      throw new AppError(
        409,
        `approved bugs ${prior} and ${b.id} share the id prefix ${prefix}; scenario/criterion ids would collide`,
      ).withCode('scenario_id_collision');
    }
    byPrefix.set(prefix, b.id);
  }
  return approved
    .map((b) => ({
      scenario_id: `scn_${b.id.slice(0, 8)}`,
      criterion_id: `crit_${b.id.slice(0, 8)}`,
      title: `${b.kind} @ ${b.location.file}:${b.location.line}`,
      gherkin: null,
      failing_test: { path: b.failing_test.path, name: b.failing_test.name },
      status: 'approved' as const,
      source: { kind: 'bug_report' as const, approval_id: input.approvalId, artifact_sha256: input.reportHash, bug_id: b.id },
    }));
}

/**
 * The APPROVED bug ids of a marked bug-fix approval, from its G-12 structured decision(s),
 * ∩ metadata.bug_ids. null when the approval carries NO structured decision (e.g. a chat-seat
 * approve) — a caller must refuse that, never read it as "nothing approved".
 *
 * Shared with GET /api/approvals/:id/write-set (U4), which derives the bug-fix write set from
 * exactly this set, so the two readers can never disagree on which bugs were approved.
 */
export async function resolveApprovedBugIds(
  approvalId: string,
  meta: Record<string, unknown>,
): Promise<Set<string> | null> {
  const decisions = await db
    .select({ item_decisions: approvalDecisions.item_decisions })
    .from(approvalDecisions)
    .where(and(eq(approvalDecisions.approval_id, approvalId), isNotNull(approvalDecisions.item_decisions)));
  if (decisions.length === 0) return null;
  // A multi-approver roster could record several structured decisions. A bug counts as
  // approved only if EVERY structured decision approved it — the same "all approved"
  // rule the approval's own completion uses.
  let approvedBugIds: Set<string> | undefined;
  for (const d of decisions) {
    const items = ((d.item_decisions as { items?: Array<{ item_id: string; decision: string }> } | null)?.items ??
      []) as Array<{ item_id: string; decision: string }>;
    const approvedHere = new Set(items.filter((i) => i.decision === 'approve').map((i) => i.item_id));
    const prev: Set<string> | undefined = approvedBugIds;
    approvedBugIds = prev ? new Set([...prev].filter((id: string) => approvedHere.has(id))) : approvedHere;
  }

  // Only the bugs this gate was minted over can be approved by it.
  const minted = new Set(Array.isArray(meta.bug_ids) ? meta.bug_ids.map(String) : []);
  return new Set([...(approvedBugIds ?? [])].filter((id) => minted.has(id)));
}

export async function handleGetApprovedItems(req: Request, approvalId: string): Promise<Response> {
  const user = await validateAuth(req);
  if (!isUuidShape(approvalId)) throw new NotFoundError('Approval not found');

  const [approval] = await db
    .select({
      id: approvals.id,
      tenant_id: approvals.tenant_id,
      kind: approvals.kind,
      status: approvals.status,
      metadata: approvals.metadata,
    })
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.tenant_id, ctxTenantId(user.tenantId))))
    .limit(1);
  if (!approval) throw new NotFoundError('Approval not found');

  const marked = isBugFixAuthorizationRow(approval);
  if (!marked && approval.kind !== FEATURE_DESIGN_APPROVAL_KIND) {
    notApproved(
      'not_a_bug_fix_authorization',
      `approval ${approval.id} (kind ${approval.kind}) is not a bug_fix_authorization and has no approved items`,
    );
  }
  if (approval.status !== 'approved') {
    notApproved('approval_not_approved', `approval is ${approval.status}, not approved`);
  }
  const meta = (approval.metadata ?? {}) as Record<string, unknown>;

  if (!marked) {
    const scenarios = (Array.isArray(meta.scenarios) ? meta.scenarios : []) as Array<{
      scenario_id: string;
      criterion_id: string;
      title: string;
      gherkin: string | null;
    }>;
    const hash = typeof meta.scenarios_hash === 'string' ? meta.scenarios_hash : null;
    if (!hash || scenarios.length === 0) notApproved('approval_items_missing', 'approval carries no scenarios');
    const items: ApprovedItem[] = scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      criterion_id: s.criterion_id,
      title: s.title,
      gherkin: s.gherkin ?? null,
      status: 'approved',
      source: { kind: 'feature_design', approval_id: approval.id, artifact_sha256: hash },
    }));
    return jsonResponse({ items });
  }

  // RULING a (10-01): a marked GENERIC deblock row authorises no fix under ANY deblock
  // action, RETRY included (BUG_FIX_PROCEED_DEBLOCK_ACTIONS is empty) — zero bugs, said
  // loudly. Only an approved marked execution.ready_signoff row passes.
  if (!bugFixDecisionAuthorises({ kind: approval.kind, status: approval.status, deblockAction: meta.deblock_action })) {
    const action = typeof meta.deblock_action === 'string' ? meta.deblock_action : null;
    throw new AppError(
      409,
      `approval ${approval.id} was approved with deblock_action ${action ?? '(none)'}, which authorises no fix`,
      { deblock_action: action },
    ).withCode('not_authorised_for_fix');
  }

  // The per-bug outcome lives in the G-12 structured decision(s).
  const approvedBugIds = await resolveApprovedBugIds(approval.id, meta);
  if (approvedBugIds === null) notApproved('approval_items_missing', 'approval has no structured item decision');

  const reportId = typeof meta.report_id === 'string' ? meta.report_id : null;
  const reportHash = typeof meta.report_hash === 'string' ? meta.report_hash : null;
  const [report] = reportId
    ? await db
        .select({ details: projectReports.details, content_hash: projectReports.content_hash })
        .from(projectReports)
        .where(and(eq(projectReports.id, reportId), eq(projectReports.tenant_id, approval.tenant_id)))
        .limit(1)
    : [];
  if (!report?.content_hash) notApproved('approval_items_missing', 'the cited bug report is not available');
  if (report.content_hash !== reportHash) {
    notApproved('report_hash_mismatch', 'the cited bug report no longer carries the hash this approval was decided on');
  }
  const bugs = ((report.details as { bugs?: ReportBug[] } | null)?.bugs ?? []) as ReportBug[];
  const items = bugFixApprovedItems({
    approvalId: approval.id,
    reportHash: report.content_hash,
    bugs,
    approvedBugIds,
  });
  return jsonResponse({ items });
}
