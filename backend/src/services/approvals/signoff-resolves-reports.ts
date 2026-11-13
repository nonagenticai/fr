// src/services/approvals/signoff-resolves-reports.ts
//
// George 2026-10-29: when a card's SIGN-OFF is decided, fr marks that card's still-pending
// conveyor `report.json` artifacts reviewed with the same decision — approved → approved,
// rejected → needs_revision — as the same actor. The reports stay readable; only their review
// status moves, so they leave "Needs you". Spec:
// ~/.claude/plans/program/20-designs/FR-SIGNOFF-RESOLVES-REPORT-REVIEWS-2026-10-29.md
//
// Only a sign-off resolves reports. A question (ask_kind 'question') or a plain request does not.
// Only a report still `pending` is touched — an explicit human review is never overwritten.
// Only a report that existed when the sign-off was decided (created_at <= completed_at) is touched:
// a report the conveyor stores AFTER the decision is new work the human has not seen.
//
// The link is `planka_card_id`: approvals carry the Planka card id, and artifact_service stores it
// in `planka_card_id` (its `card_id` column is a UUID and is NULL on the conveyor's reports).
//
// ⛔ No route-level `assertArtifactReviewDecider` here, deliberately: the approval decision that
// triggers this already authorised the actor to sign this card off (fr R208 sign-off rights), so
// the integration is called directly. The review callback (`review_callback_url`) is not fired:
// the sign-off's own decision callback already tells the conveyor, and no report carries one.
//
// Used by every decision seat — web (routes/approvals.ts), Telegram, Teams — through
// `afterSignoffDecided`, and by scripts/backfill-signoff-report-reviews.ts.
import { listArtifacts, submitArtifactReview, type ArtifactOut, type ReviewIn } from '../../integrations/artifacts';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { CONVEYOR_REPORT_FILENAME } from '../cockpit/project-cockpit';
import { askKindOf } from '../cockpit/spine';

export interface DecidedSignoff {
  id: string;
  tenant_id: string;
  project_id: string | null;
  card_id: string | null;
  metadata: unknown;
  /** When the decision completed the approval (approvals.completed_at) — the report cutoff. */
  completed_at: Date | string | null;
}

type ReportRow = ArtifactOut;

const LIST_LIMIT = 1000;

/**
 * How one resolution runs. The live seats use the defaults. The backfill
 * (scripts/backfill-signoff-report-reviews.ts) passes `apply: false` for a dry
 * run — the reports that would be resolved are listed in `resolved` and nothing
 * is written — and `exclude`, the reports an earlier pass already took.
 */
interface ResolveReportsOptions {
  apply?: boolean;
  exclude?: ReadonlySet<string>;
}

type ResolveReportsOutcome =
  | { outcome: 'skipped'; reason: 'not_signoff' | 'not_decided' | 'no_card' | 'no_project' | 'no_decided_at' }
  | { outcome: 'done'; resolved: string[]; failed: string[]; already_reviewed: number };

/** artifact_service DECISION_TO_STATUS: approve → approved, revise → needs_revision (reject → rejected). */
function reviewDecisionFor(status: string): ReviewIn['decision'] | null {
  if (status === 'approved') return 'approve';
  if (status === 'rejected') return 'revise';
  return null;
}

/** ms since epoch; a zone-less timestamp is read as UTC (artifact_service stores UTC). NaN if unreadable. */
function epochMs(v: Date | string): number {
  if (v instanceof Date) return v.getTime();
  return Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`);
}

/**
 * Resolve the card's pending reports for one decided sign-off. Never throws: a list failure is
 * recorded (reportSwallowedFailure) and answered as a `done` with nothing resolved; a failed review
 * of one report is recorded and the rest still go.
 */
export async function resolveCardReportsForSignoff(
  approval: DecidedSignoff,
  status: string,
  deciderId: string,
  opts: ResolveReportsOptions = {},
): Promise<ResolveReportsOutcome> {
  if (askKindOf({ metadata: approval.metadata as never }) !== 'signoff') return { outcome: 'skipped', reason: 'not_signoff' };
  const decision = reviewDecisionFor(status);
  if (!decision) return { outcome: 'skipped', reason: 'not_decided' };
  if (!approval.card_id) return { outcome: 'skipped', reason: 'no_card' };
  if (!approval.project_id) return { outcome: 'skipped', reason: 'no_project' };
  if (!approval.completed_at) return { outcome: 'skipped', reason: 'no_decided_at' };
  const decidedAt = epochMs(approval.completed_at);
  const projectId = approval.project_id;
  const cardId = approval.card_id;
  const as = { tenantId: approval.tenant_id, subjectId: deciderId };
  const out = { outcome: 'done' as const, resolved: [] as string[], failed: [] as string[], already_reviewed: 0 };

  let rows: ReportRow[];
  try {
    rows = await listArtifacts(projectId, { planka_card_id: cardId, limit: LIST_LIMIT }, as);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'artifacts',
      method: 'signoff-resolves-reports.list',
      degradedTo: `card ${cardId} reports left pending after sign-off ${approval.id}`,
    });
    return out;
  }
  // An unreadable created_at cannot be shown to predate the decision, so it is left pending.
  const reports = rows.filter(
    (a) => !opts.exclude?.has(a.id) && a.filename === CONVEYOR_REPORT_FILENAME && a.planka_card_id === cardId && epochMs(a.created_at) <= decidedAt,
  );
  const comment = `Resolved by sign-off ${approval.id} (${status}).`;
  for (const r of reports) {
    if (r.status !== 'pending') {
      out.already_reviewed += 1;
      continue;
    }
    try {
      if (opts.apply !== false) await submitArtifactReview(projectId, r.id, { decision, comment }, as);
      out.resolved.push(r.id);
    } catch (err) {
      out.failed.push(r.id);
      reportSwallowedFailure(err, {
        service: 'artifacts',
        method: 'signoff-resolves-reports.review',
        degradedTo: `report ${r.id} left pending after sign-off ${approval.id}`,
      });
    }
  }
  return out;
}

// ── Every decision seat calls this, after its durable completing UPDATE ─────────────────────
//
// Detached, deliberately: the reviews are serial artifact_service calls (30 s client timeout
// each), and a sign-off decision must never wait on them. `resolveCardReportsForSignoff` never
// throws; the catch is the belt for a bug in it, and is reported, never silent.
/** Fire the report resolution for a just-completed approval. Returns at once; never throws. */
export function afterSignoffDecided(updated: DecidedSignoff, finalStatus: string, deciderId: string): void {
  void resolveCardReportsForSignoff(updated, finalStatus, deciderId).catch((err: unknown) => {
    reportSwallowedFailure(err, {
      service: 'artifacts',
      method: 'signoff-resolves-reports.afterSignoffDecided',
      degradedTo: `card ${updated.card_id ?? 'none'} reports left pending after sign-off ${updated.id}`,
    });
  });
}
